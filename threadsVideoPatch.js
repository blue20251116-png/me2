const benchmark = require('./benchmarkAccounts');

const originalCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function isHttpVideoUrl(value) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(s)) return true;
  if (/fbcdn|cdninstagram|threads|instagram/i.test(s) && /video|mp4|bytestart|byteend/i.test(s)) return true;
  return false;
}

async function extractPlayableVideoUrls(postUrl) {
  const playwright = require('playwright');
  let browser;
  const found = [];
  const add = (url) => {
    const s = String(url || '').trim();
    if (!isHttpVideoUrl(s)) return;
    if (!found.includes(s)) found.push(s);
  };

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1100, height: 1500 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const headers = await response.allHeaders().catch(() => ({}));
        const type = String(headers['content-type'] || '').toLowerCase();
        if (type.startsWith('video/') || isHttpVideoUrl(url)) add(url);
      } catch {}
    });

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(2200);

    try {
      await page.evaluate(() => {
        for (const v of document.querySelectorAll('video')) {
          try { v.muted = true; v.play().catch(() => {}); } catch {}
        }
      });
    } catch {}

    await page.waitForTimeout(1800);

    const domUrls = await page.evaluate(() => {
      const out = [];
      const add = (v) => {
        const s = String(v || '').trim();
        if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
      };
      for (const v of document.querySelectorAll('video')) {
        add(v.currentSrc);
        add(v.src);
        for (const s of v.querySelectorAll('source[src]')) add(s.src || s.getAttribute('src'));
        for (const key of ['data-src', 'data-video-url', 'data-url']) add(v.getAttribute(key));
      }
      for (const selector of [
        'meta[property="og:video"]',
        'meta[property="og:video:url"]',
        'meta[property="og:video:secure_url"]',
        'meta[name="twitter:player:stream"]',
      ]) {
        add(document.querySelector(selector)?.content);
      }
      try {
        for (const e of performance.getEntriesByType('resource')) add(e.name);
      } catch {}
      return out;
    });
    for (const u of domUrls) add(u);

    await context.close();
  } catch (err) {
    console.warn(`[Threads][VIDEO EXTRACT] fallback 실패 url=${postUrl} reason="${err.message}"`);
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }

  return found.slice(0, 5);
}

benchmark.collectPostDetails = async function patchedCollectPostDetails(url, username) {
  const details = await originalCollectPostDetails(url, username);
  const existing = Array.isArray(details?.videos)
    ? details.videos.filter(isHttpVideoUrl)
    : [];

  if (existing.length) {
    return { ...details, videos: existing, hasVideo: true };
  }

  if (!details?.hasVideo) return details;

  const videos = await extractPlayableVideoUrls(url);
  console.log(`[Threads][VIDEO EXTRACT] @${username || '-'} detected=${details?.hasVideo ? 'yes' : 'no'} playable=${videos.length}`);
  return {
    ...details,
    videos,
    hasVideo: details?.hasVideo || videos.length > 0,
  };
};

console.log('[Threads][VIDEO PATCH] 영상 src/source/og:video/network URL 추출 활성화');
