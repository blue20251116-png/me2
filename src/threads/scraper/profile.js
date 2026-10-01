'use strict';
// Reads the newest posts from a Threads profile page.
const { openBrowser } = require('./session');

async function collectProfilePostsWithContext(context, username, { limit = 2 } = {}) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(12000);
    await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 12000,
    });
    await page.waitForTimeout(1600);
    const scrollRounds = Math.max(6, Math.min(24, Math.ceil(Number(limit || 2) / 2) + 4));
    for (let i = 0; i < scrollRounds; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(i < 4 ? 350 : 220);
    }
    const __profileDiag = await page.evaluate(() => ({
      finalUrl: location.href,
      title: String(document.title || '').slice(0, 160),
      anchors: document.querySelectorAll('a').length,
      postLinks: document.querySelectorAll('a[href*="/post/"]').length,
      articles: document.querySelectorAll('article,[role="article"]').length,
      hrefSamples: [...document.querySelectorAll('a[href]')]
        .map(a => {
          try {
            return new URL(a.href, location.origin).pathname;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .slice(0, 12),
      bodyText: String(document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220),
    }));
    const __profileResult = await page.evaluate(
      ({ username, limit }) => {
        const clean = s =>
          String(s || '')
            .replace(/\s+/g, ' ')
            .trim();
        const canonical = href => {
          try {
            const u = new URL(href, location.origin);
            return `${u.origin}${u.pathname}`;
          } catch {
            return String(href || '').split(/[?#]/)[0];
          }
        };
        const rectOverlap = (a, b) => {
          const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const inter = x * y;
          if (!inter) return 0;
          return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
        };
        const findRoot = (a, target) => {
          const article = a.closest('article,[role="article"]');
          if (article && clean(article.innerText).length >= 8) return article;
          let node = a.parentElement,
            best = null;
          for (let i = 0; i < 9 && node; i++, node = node.parentElement) {
            const txt = clean(node.innerText);
            if (txt.length < 8) continue;
            const links = [...node.querySelectorAll('a[href*="/post/"]')].map(x => canonical(x.href));
            const uniq = [...new Set(links)];
            if (uniq.length === 1 && uniq[0] === target && txt.length <= 5000) best = node;
            if (uniq.length > 1 && best) break;
          }
          return best;
        };
        const mediaFromRoot = (root, target) => {
          if (!root) return { images: [], hasVideo: false, videoCount: 0 };
          const videos = [...root.querySelectorAll('video')].filter(v => {
            const r = v.getBoundingClientRect();
            return r.width >= 180 && r.height >= 180;
          });
          const videoRects = videos.map(v => v.getBoundingClientRect());
          const images = [];
          for (const img of root.querySelectorAll('img')) {
            const r = img.getBoundingClientRect(),
              src = img.currentSrc || img.src || '',
              alt = (img.alt || '').toLowerCase();
            if (!src || r.width < 180 || r.height < 180) continue;
            if (/profile|프로필|avatar|사용자/.test(alt)) continue;
            const nestedArticle = img.closest('article,[role="article"]');
            if (nestedArticle && nestedArticle !== root) continue;
            const postAnchor = img.closest('a[href*="/post/"]');
            if (postAnchor && canonical(postAnchor.href || '') !== target) continue;
            if (videoRects.some(vr => rectOverlap(r, vr) >= 0.55)) continue;
            if (img.closest('video') || img.parentElement?.querySelector?.('video')) continue;
            if (!images.includes(src)) images.push(src);
          }
          return { images: images.slice(0, 10), hasVideo: videos.length > 0, videoCount: videos.length };
        };
        const out = [],
          seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/post/"]')) {
          if (out.length >= limit) break;
          const href = canonical(a.href || '');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          let p = '';
          try {
            p = new URL(href).pathname;
          } catch {}
          if (!/\/post\//i.test(p)) continue;
          const root = findRoot(a, href);
          if (!root) continue;
          const text = clean(root.innerText || '').slice(0, 1800);
          if (text.length < 8) continue;
          const media = mediaFromRoot(root, href);
          out.push({
            url: href,
            text,
            username,
            images: media.images,
            thumbnail: media.images[0] || '',
            imageCount: media.images.length,
            hasVideo: media.hasVideo,
            videoCount: media.videoCount,
          });
        }
        return out;
      },
      { username, limit }
    );
    const __login = /\/login\//i.test(__profileDiag.finalUrl) || /Threads\s*[•·]\s*로그인/i.test(__profileDiag.title);
    const __errorShell = /문제가 발생했습니다|나중에 다시 시도/i.test(__profileDiag.bodyText);
    const __challenged = __login || __errorShell;
    if (__profileResult.length && !__challenged) context.__threadsStateHealthy = true;
    if (__challenged) Object.defineProperty(__profileResult, '__threadsChallenge', { value: true, enumerable: false });
    const __diagMsg = `@${username} final=${__profileDiag.finalUrl} title=${JSON.stringify(__profileDiag.title)} postLinks=${__profileDiag.postLinks} anchors=${__profileDiag.anchors} articles=${__profileDiag.articles} hrefs=${JSON.stringify(__profileDiag.hrefSamples)} body=${JSON.stringify(__profileDiag.bodyText)}`;
    if (__profileResult.length && !__challenged)
      console.log(`[Threads][PROFILE OK] ${__diagMsg} posts=${__profileResult.length}`);
    else console.error(`[Threads][PROFILE ${__challenged ? 'CHALLENGED' : 'EMPTY'}] ${__diagMsg}`);
    return __profileResult;
  } finally {
    try {
      await page.close();
    } catch {}
  }
}

async function collectProfilePosts(username, { limit = 2 } = {}) {
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    return await collectProfilePostsWithContext(context, username, { limit });
  } finally {
    if (context)
      try {
        await context.close();
      } catch {}
    if (browser)
      try {
        await browser.close();
      } catch {}
  }
}

module.exports = { collectProfilePostsWithContext, collectProfilePosts };
