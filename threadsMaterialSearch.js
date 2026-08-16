const SEARCH_TIMEOUT_MS = 30000;

function normalizePostUrl(raw) {
  try {
    const u = new URL(raw, 'https://www.threads.com');
    if (!/(^|\.)threads\.(com|net)$/i.test(u.hostname)) return null;
    if (!/\/post\//i.test(u.pathname)) return null;
    u.hash = '';
    // 추적 파라미터는 제거해서 같은 게시물이 중복되지 않게 한다.
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function searchThreadsMaterials(keyword, { limit = 10 } = {}) {
  const q = String(keyword || '').trim();
  if (!q) throw new Error('검색어를 입력해주세요.');

  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    throw new Error('Threads 검색용 Chromium이 설치되어 있지 않습니다. 최신 배포인지 확인해주세요.');
  }

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
    page.setDefaultTimeout(SEARCH_TIMEOUT_MS);

    const searchUrl = `https://www.threads.com/search?q=${encodeURIComponent(q)}&serp_type=default`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: SEARCH_TIMEOUT_MS });
    await page.waitForTimeout(4500);

    // 결과가 늦게 붙는 경우를 대비해 약간 스크롤한다.
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 1100);
      await page.waitForTimeout(1000);
    }

    const raw = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = [...document.querySelectorAll('a[href*="/post/"]')];
      for (const a of anchors) {
        const href = a.href || a.getAttribute('href') || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);

        let root = a;
        for (let i = 0; i < 7 && root?.parentElement; i += 1) {
          root = root.parentElement;
          const t = (root.innerText || '').trim();
          if (t.length >= 30) break;
        }
        const text = String(root?.innerText || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900);
        const img = root?.querySelector?.('img');
        const video = root?.querySelector?.('video');
        out.push({
          url: href,
          text,
          thumbnail: img?.src || '',
          hasVideo: !!video,
        });
      }
      return out;
    });

    const deduped = [];
    const seen = new Set();
    for (const item of raw) {
      const url = normalizePostUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      deduped.push({
        url,
        text: String(item.text || '').trim(),
        thumbnail: String(item.thumbnail || ''),
        hasVideo: !!item.hasVideo,
      });
      if (deduped.length >= Math.max(1, Math.min(Number(limit) || 10, 20))) break;
    }

    await context.close();
    return { keyword: q, searchUrl, items: deduped };
  } catch (err) {
    throw new Error(`Threads 소재 검색에 실패했습니다: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { searchThreadsMaterials };
