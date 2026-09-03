const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 200 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20000;
const VIDEO_TIMEOUT_MS = 120000;
const BROWSER_TIMEOUT_MS = 30000;
let directCooldownUntil = 0;

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
  u.pathname = u.pathname.replace(/\/media\/?$/i, '').replace(/\/+$/, '');
  u.search = '';
  u.hash = '';
  return u.toString();
}

function mediaViewUrl(sourceUrl) {
  return `${String(sourceUrl || '').replace(/\/+$/, '')}/media`;
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
  if (!decoded || decoded.startsWith('blob:') || !isAllowedMediaUrl(decoded)) return;
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
    /"progressive_url"\s*:\s*"([^"]+)"/gi,
    /"url"\s*:\s*"(https?:\\?\/\\?\/[^"<>]+?(?:\.mp4|video)[^"<>]*)"/gi,
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
    return { videos: [], poster: '', title: '', requestHeaders: {}, unavailable: true };
  }

  const videos = [];
  let browser;
  let poster = '';
  let title = '';
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    });
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1280, height: 1600 },
      userAgent,
      extraHTTPHeaders: { 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' },
    });

    const inspectUrl = raw => {
      if (!raw) return;
      const s = String(raw);
      if (/\.mp4(?:\?|$)/i.test(s) || /video/i.test(s) || /bytestart|byteend|range=/i.test(s)) pushCandidate(videos, s);
    };

    const scanPage = async targetUrl => {
      const page = await context.newPage();
      page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
      page.on('request', request => inspectUrl(request.url()));
      page.on('response', async response => {
        const responseUrl = response.url();
        inspectUrl(responseUrl);
        try {
          const headers = await response.allHeaders().catch(() => ({}));
          const type = String(headers['content-type'] || '').toLowerCase();
          if (type.startsWith('video/') || type.includes('application/octet-stream')) pushCandidate(videos, responseUrl);
        } catch {}
      });

      try {
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await page.waitForTimeout(2600);
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, 650);
          await page.waitForTimeout(250);
        }

        try {
          const video = page.locator('video').first();
          if (await video.count()) {
            await video.scrollIntoViewIfNeeded().catch(() => {});
            await video.click({ force: true, timeout: 1500 }).catch(() => {});
          }
        } catch {}

        try {
          await page.evaluate(() => {
            for (const v of document.querySelectorAll('video')) {
              try {
                v.muted = true;
                v.autoplay = true;
                v.playsInline = true;
                v.controls = true;
                v.load?.();
                const p = v.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
              } catch {}
            }
          });
        } catch {}

        try {
          const playButtons = page.getByRole('button', { name: /play|재생/i });
          const n = Math.min(await playButtons.count(), 3);
          for (let i = 0; i < n; i++) await playButtons.nth(i).click({ force: true, timeout: 1200 }).catch(() => {});
        } catch {}

        await page.waitForTimeout(4200);

        try {
          const html = await page.content();
          const embedded = extractCandidates(html);
          for (const u of embedded.videos) pushCandidate(videos, u);
          if (!poster) poster = embedded.poster || '';
          if (!title) title = embedded.title || '';
        } catch {}

        try {
          const domUrls = await page.evaluate(() => {
            const out = [];
            const add = value => {
              const s = String(value || '').trim();
              if (s && !out.includes(s)) out.push(s);
            };
            document.querySelectorAll('video').forEach(video => {
              add(video.currentSrc);
              add(video.src);
              add(video.getAttribute('src'));
              for (const key of ['data-src', 'data-video-url', 'data-url', 'data-playable-url']) add(video.getAttribute(key));
              video.querySelectorAll('source[src]').forEach(source => add(source.src || source.getAttribute('src')));
            });
            document.querySelectorAll('source[src]').forEach(source => add(source.src || source.getAttribute('src')));
            for (const selector of [
              'meta[property="og:video"]',
              'meta[property="og:video:url"]',
              'meta[property="og:video:secure_url"]',
              'meta[name="twitter:player:stream"]',
            ]) add(document.querySelector(selector)?.content);
            try { for (const entry of performance.getEntriesByType('resource')) add(entry?.name); } catch {}
            return out;
          });
          for (const raw of domUrls) inspectUrl(raw);
        } catch {}

        if (!poster || !title) {
          try {
            const meta = await page.evaluate(() => ({
              poster: document.querySelector('meta[property="og:image"]')?.content || document.querySelector('video')?.poster || '',
              title: document.querySelector('meta[property="og:title"]')?.content || document.title || '',
            }));
            if (!poster) poster = meta.poster || '';
            if (!title) title = meta.title || '';
          } catch {}
        }

        const domVideoCount = await page.locator('video').count().catch(() => 0);
        console.log(`[Threads import][BROWSER_SCAN] status=${response?.status?.() ?? '-'} url=${targetUrl} domVideos=${domVideoCount} candidates=${videos.length}`);
      } finally {
        try { await page.close(); } catch {}
      }
    };

    // 일반 post 뷰에서 CDN URL이 노출되지 않는 게시물이 있어 /media 뷰까지 반드시 재시도한다.
    await scanPage(sourceUrl);
    if (!videos.length) await scanPage(mediaViewUrl(sourceUrl));

    let cookieHeader = '';
    try {
      const cookies = await context.cookies();
      cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch {}
    const requestHeaders = {
      'user-agent': userAgent,
      referer: mediaViewUrl(sourceUrl),
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
    };
    if (cookieHeader) requestHeaders.cookie = cookieHeader;

    await context.close();
    return { videos, poster, title, requestHeaders, unavailable: false };
  } catch (err) {
    return { videos, poster, title, requestHeaders: {}, unavailable: false, error: err };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

async function downloadCandidate(videoUrl, outputDir, requestHeaders = {}) {
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
        'user-agent': requestHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
        referer: requestHeaders.referer || 'https://www.threads.com/',
        'accept-language': requestHeaders['accept-language'] || 'ko-KR,ko;q=0.9,en;q=0.8',
        ...(requestHeaders.cookie ? { cookie: requestHeaders.cookie } : {}),
        accept: 'video/*,*/*;q=0.8',
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

async function tryDownloadCandidates(candidates, outputDir, requestHeaders = {}) {
  let lastError = null;
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const file = await downloadCandidate(candidate, outputDir, requestHeaders);
      return { file, mediaUrl: candidate };
    } catch (err) {
      lastError = err;
      console.warn(`[Threads import] candidate download failed: ${err.message}`);
    }
  }
  return { file: null, mediaUrl: '', lastError };
}

async function importThreadsVideo({ url, outputDir }) {
  const sourceUrl = validateThreadsUrl(url);
  let direct = { videos: [], poster: '', title: '' };

  if (Date.now() >= directCooldownUntil) {
    try {
      const html = await fetchPostPage(sourceUrl);
      direct = extractCandidates(html);
    } catch (err) {
      if (err.response?.status === 429) {
        directCooldownUntil = Date.now() + 10 * 60 * 1000;
        console.warn('[Threads import] direct HTML 429 → 10분 cooldown, Chromium fallback 사용');
      } else if (err.response?.status !== 401 && err.response?.status !== 403) {
        console.warn('[Threads import] direct HTML fetch failed:', err.message);
      }
    }
  } else {
    console.log('[Threads import] direct HTML cooldown 중 → Chromium 우선');
  }

  if (direct.videos.length) {
    const saved = await tryDownloadCandidates(direct.videos, outputDir, { referer: sourceUrl });
    if (saved.file) {
      return { ...saved.file, sourceUrl, mediaUrl: saved.mediaUrl, poster: direct.poster, title: direct.title, extractionMethod: 'html' };
    }
  }

  const browserFound = await extractCandidatesWithBrowser(sourceUrl);
  if (browserFound.videos.length) {
    const saved = await tryDownloadCandidates(browserFound.videos, outputDir, browserFound.requestHeaders || { referer: sourceUrl });
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

  if (browserFound.unavailable) throw new Error('HTML에서 영상을 찾지 못했고 서버에 Chromium 추출기가 설치되어 있지 않습니다. 최신 배포인지 확인해주세요.');
  if (browserFound.error) throw new Error(`Threads 브라우저 추출에도 실패했습니다: ${browserFound.error.message}`);
  throw new Error('Threads 페이지에서 영상 게시물은 확인했지만 재생 가능한 영상 주소를 찾지 못했습니다. 일반 post 뷰와 /media 뷰를 모두 확인했습니다.');
}

module.exports = { validateThreadsUrl, extractCandidates, extractCandidatesWithBrowser, importThreadsVideo };
if (process.env.ME2_BROWSER_WORKER !== '1') {
  const { isolatedBrowserTask } = require('./isolatedTask');
  for (const method of ['importThreadsVideo','extractCandidatesWithBrowser']) {
    module.exports[method] = (...args) => isolatedBrowserTask('threadsMediaImporter', method, args, 180000);
  }
}
