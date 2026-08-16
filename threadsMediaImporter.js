const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 200 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20000;
const VIDEO_TIMEOUT_MS = 120000;

function validateThreadsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('올바른 Threads 게시물 URL을 입력해주세요.');
  }
  if (u.protocol !== 'https:') throw new Error('https Threads URL만 사용할 수 있습니다.');
  const host = u.hostname.toLowerCase();
  const allowed =
    host === 'threads.com' || host.endsWith('.threads.com') ||
    host === 'threads.net' || host.endsWith('.threads.net');
  if (!allowed) throw new Error('Threads 공개 게시물 URL만 사용할 수 있습니다.');
  if (!/\/post\//i.test(u.pathname)) throw new Error('Threads 게시물 주소(/post/...)를 입력해주세요.');
  u.hash = '';
  return u.toString();
}

function decodeEscapedUrl(value) {
  if (!value) return '';
  let s = String(value).trim();
  s = s
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#x26;/gi, '&');
  try { s = decodeURIComponent(s); } catch {}
  return s;
}

function isAllowedMediaUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return (
      h === 'threads.com' || h.endsWith('.threads.com') ||
      h === 'threads.net' || h.endsWith('.threads.net') ||
      h === 'instagram.com' || h.endsWith('.instagram.com') ||
      h === 'cdninstagram.com' || h.endsWith('.cdninstagram.com') ||
      h === 'fbcdn.net' || h.endsWith('.fbcdn.net')
    );
  } catch {
    return false;
  }
}

function pushCandidate(out, raw) {
  const decoded = decodeEscapedUrl(raw);
  if (!decoded || !isAllowedMediaUrl(decoded)) return;
  if (!out.includes(decoded)) out.push(decoded);
}

function extractCandidates(html) {
  const $ = cheerio.load(html);
  const videos = [];

  const metaSelectors = [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]',
  ];
  for (const sel of metaSelectors) $(sel).each((_, el) => pushCandidate(videos, $(el).attr('content')));
  $('link[rel="preload"][as="video"]').each((_, el) => pushCandidate(videos, $(el).attr('href')));

  const fieldPatterns = [
    /"video_url"\s*:\s*"([^"]+)"/gi,
    /"playable_url"\s*:\s*"([^"]+)"/gi,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/gi,
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/gi,
    /"src"\s*:\s*"(https?:\\?\/\\?\/[^"<>]+?\.mp4[^"<>]*)"/gi,
    /(https?:\\?\/\\?\/[^"'<>\s]+?\.mp4[^"'<>\s]*)/gi,
  ];
  for (const re of fieldPatterns) {
    let m;
    while ((m = re.exec(html)) !== null) pushCandidate(videos, m[1] || m[0]);
  }

  const poster = decodeEscapedUrl(
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') || ''
  );
  const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';

  return { videos, poster, title: String(title).trim() };
}

async function fetchPostPage(url) {
  const response = await axios.get(url, {
    timeout: PAGE_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      accept: 'text/html,application/xhtml+xml',
    },
    validateStatus: status => status >= 200 && status < 400,
  });
  return String(response.data || '');
}

async function downloadCandidate(videoUrl, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filename = `threads-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
  const filepath = path.join(outputDir, filename);
  const writer = fs.createWriteStream(filepath, { flags: 'wx' });
  let bytes = 0;

  try {
    const response = await axios.get(videoUrl, {
      timeout: VIDEO_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'stream',
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
        referer: 'https://www.threads.com/',
      },
      validateStatus: status => status >= 200 && status < 400,
    });

    const type = String(response.headers['content-type'] || '').toLowerCase();
    if (type && !type.startsWith('video/') && !type.includes('octet-stream')) {
      response.data.destroy();
      throw new Error(`영상 파일이 아닌 응답을 받았습니다 (${type}).`);
    }

    const declared = Number(response.headers['content-length'] || 0);
    if (declared > MAX_BYTES) {
      response.data.destroy();
      throw new Error('영상이 200MB를 초과합니다.');
    }

    await new Promise((resolve, reject) => {
      response.data.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          response.data.destroy(new Error('영상이 200MB를 초과합니다.'));
        }
      });
      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      response.data.pipe(writer);
    });

    if (bytes < 1024) throw new Error('가져온 영상 파일이 비정상적으로 작습니다.');
    return { filename, filepath, size: bytes };
  } catch (err) {
    try { writer.destroy(); } catch {}
    try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {}
    throw err;
  }
}

async function importThreadsVideo({ url, outputDir }) {
  const sourceUrl = validateThreadsUrl(url);
  let html;
  try {
    html = await fetchPostPage(sourceUrl);
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('Threads가 이 게시물 페이지 접근을 제한했습니다. 공개 게시물인지 확인해주세요.');
    }
    throw new Error(`Threads 게시물을 불러오지 못했습니다: ${err.message}`);
  }

  const found = extractCandidates(html);
  if (!found.videos.length) {
    throw new Error('이 게시물에서 공개 영상 주소를 찾지 못했습니다. 비공개 게시물, 이미지 게시물, 또는 Threads 페이지 구조 변경일 수 있습니다.');
  }

  let lastError = null;
  for (const candidate of found.videos.slice(0, 8)) {
    try {
      const file = await downloadCandidate(candidate, outputDir);
      return {
        ...file,
        sourceUrl,
        mediaUrl: candidate,
        poster: found.poster,
        title: found.title,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`영상 주소는 찾았지만 파일 저장에 실패했습니다${lastError ? `: ${lastError.message}` : ''}`);
}

module.exports = {
  validateThreadsUrl,
  extractCandidates,
  importThreadsVideo,
};