const SEARCH_TIMEOUT_MS = 30000;

const AUTO_KEYWORDS = {
  recipe: [
    '간단요리', '집밥 레시피', '자취요리', '오늘뭐먹지', '초간단 레시피',
    '에어프라이어 요리', '또띠아 요리', '볶음밥 레시피', '고기요리', '야식 레시피',
  ],
  product: [
    '살림템', '주방용품 추천', '생활용품 추천', '자취템', '청소템',
    '수납템', '차량용품', '신박한 제품', '생활꿀템', '운동용품',
  ],
};

function normalizePostUrl(raw) {
  try {
    const u = new URL(raw, 'https://www.threads.com');
    if (!/(^|\.)threads\.(com|net)$/i.test(u.hostname)) return null;
    if (!/\/post\//i.test(u.pathname)) return null;
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

function chooseAutoKeyword(mode = 'recipe') {
  const pool = mode === 'product' ? AUTO_KEYWORDS.product : AUTO_KEYWORDS.recipe;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function searchThreadsMaterials(keyword, { limit = 10, mode = 'recipe' } = {}) {
  const q = String(keyword || '').trim() || chooseAutoKeyword(mode);

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
        const images = [...(root?.querySelectorAll?.('img') || [])].map(img => img.src).filter(Boolean);
        const video = root?.querySelector?.('video');
        out.push({ href, text, thumbnail: images[0] || '', imageCount: images.length, hasVideo: !!video });
      }
      return out;
    });

    const deduped = [];
    const seen = new Set();
    for (const item of raw) {
      const url = normalizePostUrl(item.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      deduped.push({
        url,
        text: String(item.text || '').trim(),
        thumbnail: String(item.thumbnail || ''),
        imageCount: Number(item.imageCount) || 0,
        hasVideo: !!item.hasVideo,
      });
    }

    // 미디어가 감지된 게시물을 먼저 보여준다.
    deduped.sort((a, b) => Number(b.hasVideo || b.imageCount > 0) - Number(a.hasVideo || a.imageCount > 0));
    await context.close();
    return {
      keyword: q,
      autoKeyword: !String(keyword || '').trim(),
      searchUrl,
      items: deduped.slice(0, Math.max(1, Math.min(Number(limit) || 10, 20))),
    };
  } catch (err) {
    throw new Error(`Threads 소재 검색에 실패했습니다: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { searchThreadsMaterials, chooseAutoKeyword };
