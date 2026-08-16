const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 200 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20000;
const VIDEO_TIMEOUT_MS = 120000;
const BROWSER_TIMEOUT_MS = 30000;

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

async function extractCandidatesWithBrowser(sourceUrl) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return { videos: [], poster: '', title: '', unavailable: true };
  }

  const videos = [];
  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1280, height: 1600 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

    const inspectUrl = raw => {
      if (!raw) return;
      const s = String(raw);
      if (/\.mp4(?:\?|$)/i.test(s) || /video/i.test(s)) pushCandidate(videos, s);
    };

    page.on('request', request => inspectUrl(request.url()));
    page.on('response', async response => {
      const url = response.url();
      inspectUrl(url);
      try {
        const type = String(response.headers()['content-type'] || '').toLowerCase();
        if (type.startsWith('video/') || type.includes('application/octet-stream')) pushCandidate(videos, url);
      } catch {}
    });

    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
    await page.waitForTimeout(3500);

    // 실제 video 요소가 만들어졌다면 재생을 한번 시도해 CDN 요청을 발생시킨다.
    try {
      await page.locator('video').first().evaluate(video => {
        video.muted = true;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      });
    } catch {}
    await page.waitForTimeout(4500);

    // DOM 속성과 Performance API에 남은 영상 URL도 추가 수집한다.
    try {
      const domUrls = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('video, source').forEach(el => {
          for (const key of ['src', 'currentSrc']) {
            const value = el[key] || el.getAttribute?.(key);
            if (value) out.push(value);
          }
        });
        for (const entry of performance.getEntriesByType('resource')) {
          if (entry && entry.name) out.push(entry.name);
        }
        return out;
      });
      for (const raw of domUrls) inspectUrl(raw);
    } catch {}

    let poster = '';
    let title = '';
    try {
      const meta = await page.evaluate(() => ({
        poster: document.querySelector('meta[property="og:image"]')?.content || document.querySelector('video')?.poster || '',
        title: document.querySelector('meta[property="og:title"]')?.content || document.title || '',
      }));
      poster = meta.poster || '';
      title = meta.title || '';
    } catch {}

    await context.close();
    return { videos, poster, title, unavailable: false };
  } catch (err) {
    return { videos, poster: '', title: '', unavailable: false, error: err };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
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
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
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
        if (bytes > MAX_BYTES) response.data.destroy(new Error('영상이 200MB를 초과합니다.'));
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

async function tryDownloadCandidates(candidates, outputDir) {
  let lastError = null;
  for (const candidate of candidates.slice(0, 12)) {
    try {
      const file = await downloadCandidate(candidate, outputDir);
      return { file, mediaUrl: candidate };
    } catch (err) {
      lastError = err;
    }
  }
  return { file: null, mediaUrl: '', lastError };
}

async function importThreadsVideo({ url, outputDir }) {
  const sourceUrl = validateThreadsUrl(url);
  let direct = { videos: [], poster: '', title: '' };

  try {
    const html = await fetchPostPage(sourceUrl);
    direct = extractCandidates(html);
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      // 브라우저 fallback을 계속 시도한다.
      direct = { videos: [], poster: '', title: '' };
    } else {
      console.warn('[Threads import] direct HTML fetch failed:', err.message);
    }
  }

  if (direct.videos.length) {
    const saved = await tryDownloadCandidates(direct.videos, outputDir);
    if (saved.file) {
      return {
        ...saved.file,
        sourceUrl,
        mediaUrl: saved.mediaUrl,
        poster: direct.poster,
        title: direct.title,
        extractionMethod: 'html',
      };
    }
  }

  // HTML에서 영상 주소가 안 보이면 실제 Chromium으로 게시물을 열고 네트워크에서 영상 CDN 요청을 감지한다.
  const browserFound = await extractCandidatesWithBrowser(sourceUrl);
  if (browserFound.videos.length) {
    const saved = await tryDownloadCandidates(browserFound.videos, outputDir);
    if (saved.file) {
      return {
        ...saved.file,
        sourceUrl,
        mediaUrl: saved.mediaUrl,
        poster: browserFound.poster || direct.poster,
        title: browserFound.title || direct.title,
        extractionMethod: 'browser',
      };
    }
    throw new Error(`브라우저에서 영상 주소는 찾았지만 파일 저장에 실패했습니다${saved.lastError ? `: ${saved.lastError.message}` : ''}`);
  }

  if (browserFound.unavailable) {
    throw new Error('HTML에서 영상을 찾지 못했고 서버에 Chromium 추출기가 설치되어 있지 않습니다. 최신 배포인지 확인해주세요.');
  }
  if (browserFound.error) {
    throw new Error(`Threads 브라우저 추출에도 실패했습니다: ${browserFound.error.message}`);
  }

  throw new Error('Threads 페이지를 실제 브라우저로 열어봤지만 영상 주소를 찾지 못했습니다. 비공개 게시물, 로그인 제한 또는 Meta의 추가 차단일 수 있습니다.');
}

module.exports = {
  validateThreadsUrl,
  extractCandidates,
  extractCandidatesWithBrowser,
  importThreadsVideo,
};