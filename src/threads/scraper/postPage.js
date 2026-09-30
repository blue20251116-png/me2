'use strict';
// Reads one Threads post page: text, media and the author's reply chain.
const { openBrowser } = require('./session');

async function expandReplies(page) {
  for (let round = 0; round < 5; round++) {
    let clicked = 0;
    try {
      clicked = await page.evaluate(() => {
        const clean = s =>
          String(s || '')
            .replace(/\s+/g, ' ')
            .trim();
        const re =
          /(답글\s*(?:보기|더\s*보기)|댓글\s*(?:보기|더\s*보기)|답글\s*\d+개|댓글\s*\d+개|view\s+(?:more\s+)?repl(?:y|ies)|more\s+repl(?:y|ies))/i;
        let n = 0;
        for (const el of document.querySelectorAll('button,[role="button"],a')) {
          if (n >= 12) break;
          const t = clean(el.innerText || el.textContent || '');
          if (!t || t.length > 80 || !re.test(t)) continue;
          try {
            el.click();
            n++;
          } catch {}
        }
        return n;
      });
    } catch {}
    await page.mouse.wheel(0, 850);
    await page.waitForTimeout(clicked ? 650 : 350);
    if (!clicked && round >= 2) break;
  }
}

async function collectPostDetailsRaw(url, username) {
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    const page = await context.newPage();
    page.setDefaultTimeout(16000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(1800);
    await expandReplies(page);
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(500);

    const data = await page.evaluate(
      ({ username, sourceUrl }) => {
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
        const targetUrl = canonical(sourceUrl),
          targetUser = String(username || '').toLowerCase();
        const sameUserHref = href => {
          try {
            const u = new URL(href, location.origin);
            return u.pathname.toLowerCase().replace(/\/$/, '') === `/@${targetUser}`;
          } catch {
            return false;
          }
        };
        function externalTargetsFromHref(raw) {
          const out = [];
          const add = v => {
            const s = String(v || '').trim();
            if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
          };
          try {
            const u = new URL(raw, location.origin);
            if (!/(^|\.)threads\.(com|net)$/i.test(u.hostname)) add(u.href);
            for (const key of ['u', 'url', 'target', 'redirect', 'redirect_url']) {
              const v = u.searchParams.get(key);
              if (!v) continue;
              try {
                add(decodeURIComponent(v));
              } catch {
                add(v);
              }
            }
          } catch {}
          return out;
        }
        function externalLinksFromRoot(root) {
          if (!root) return [];
          const out = [];
          for (const a of root.querySelectorAll('a[href]')) {
            for (const u of externalTargetsFromHref(a.href || a.getAttribute('href') || ''))
              if (!out.includes(u)) out.push(u);
          }
          const txt = clean(root.innerText || '');
          const matches = txt.match(/https?:\/\/[^\s)\]}>,]+/gi) || [];
          for (const u of matches) if (!out.includes(u)) out.push(u);
          return out.slice(0, 12);
        }
        function compactRoot(anchor) {
          const article = anchor.closest('article,[role="article"]');
          if (article) return article;
          let node = anchor.parentElement,
            best = null;
          for (let i = 0; i < 9 && node; i++, node = node.parentElement) {
            const text = clean(node.innerText || '');
            if (text.length < 8) continue;
            if (text.length <= 5000) best = node;
            if (text.length > 5000 && best) break;
          }
          return best;
        }
        function postLinks(root) {
          return root
            ? [...new Set([...root.querySelectorAll('a[href*="/post/"]')].map(a => canonical(a.href || '')))]
            : [];
        }
        function isMainRoot(root) {
          return !!root && postLinks(root).includes(targetUrl);
        }
        function replyTextWithLinks(root) {
          const text = clean(root?.innerText || '').slice(0, 4000);
          const links = externalLinksFromRoot(root);
          return [text, ...links].filter(Boolean).join('\n').slice(0, 6000);
        }

        let main = null;
        for (const a of document.querySelectorAll('a[href*="/post/"]')) {
          if (canonical(a.href || '') !== targetUrl) continue;
          const root = compactRoot(a);
          if (!root) continue;
          if (!main || clean(root.innerText).length < clean(main.innerText).length) main = root;
        }
        const metaDescription = clean(
          document.querySelector('meta[property="og:description"]')?.content ||
            document.querySelector('meta[name="description"]')?.content ||
            ''
        );
        const sourceText = clean(main?.innerText || metaDescription || '').slice(0, 5000);

        const images = [],
          videos = [];
        if (main) {
          const rectOverlap = (a, b) => {
            const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            const inter = x * y;
            if (!inter) return 0;
            return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
          };
          const videoEls = [...main.querySelectorAll('video')].filter(v => {
            const r = v.getBoundingClientRect();
            return r.width >= 160 && r.height >= 160;
          });
          const videoRects = videoEls.map(v => v.getBoundingClientRect());
          for (const v of videoEls) {
            const src = v.currentSrc || v.src || '';
            if (src && !videos.includes(src)) videos.push(src);
          }
          for (const img of main.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '',
              alt = (img.alt || '').toLowerCase();
            const r = img.getBoundingClientRect();
            if (!src || r.width < 160 || r.height < 160) continue;
            if (/profile|프로필|avatar|사용자/.test(alt)) continue;
            const nestedArticle = img.closest('article,[role="article"]');
            if (nestedArticle && nestedArticle !== main) continue;
            const postAnchor = img.closest('a[href*="/post/"]');
            if (postAnchor && canonical(postAnchor.href || '') !== targetUrl) continue;
            if (videoRects.some(vr => rectOverlap(r, vr) >= 0.55)) continue;
            if (img.closest('video') || img.parentElement?.querySelector?.('video')) continue;
            if (!images.includes(src)) images.push(src);
          }
        }

        const authorReplies = [],
          seen = new Set(),
          authorRoots = new Set();
        const authorAnchors = [...document.querySelectorAll('a[href]')].filter(a =>
          sameUserHref(a.href || a.getAttribute('href') || '')
        );
        for (const a of authorAnchors) {
          const root = compactRoot(a);
          if (!root || root === main || isMainRoot(root)) continue;
          authorRoots.add(root);
        }
        for (const block of document.querySelectorAll('article,[role="article"]')) {
          if (block === main || isMainRoot(block)) continue;
          const anchors = [...block.querySelectorAll('a[href]')];
          if (anchors.some(a => sameUserHref(a.href || a.getAttribute('href') || ''))) authorRoots.add(block);
        }
        for (const root of authorRoots) {
          const reply = replyTextWithLinks(root);
          if (!reply || reply.length < 8 || seen.has(reply)) continue;
          seen.add(reply);
          authorReplies.push(reply);
        }

        const allAffiliateLinks = [];
        for (const reply of authorReplies) {
          const matches = reply.match(/https?:\/\/[^\s)\]}>,]+/gi) || [];
          for (const m of matches) {
            if (/coupang|naver/i.test(m) && !allAffiliateLinks.includes(m)) allAffiliateLinks.push(m);
          }
        }
        return {
          sourceText,
          authorReplies: authorReplies.slice(0, 15),
          images: images.slice(0, 10),
          videos: videos.slice(0, 5),
          hasVideo: videos.length > 0,
          exactUrl: canonical(location.href) === targetUrl,
          metaDescription,
          authorAnchorCount: authorAnchors.length,
          authorRootCount: authorRoots.size,
          affiliateLinkCount: allAffiliateLinks.length,
        };
      },
      { username, sourceUrl: url }
    );

    const sourceText = String(data.sourceText || data.metaDescription || '').trim();
    if (!sourceText) throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
    console.log(
      `[Threads detail] @${username} source=${sourceText.length} replies=${(data.authorReplies || []).length} authorAnchors=${data.authorAnchorCount || 0} authorRoots=${data.authorRootCount || 0} affiliateLinks=${data.affiliateLinkCount || 0} images=${(data.images || []).length} videos=${(data.videos || []).length}`
    );
    return {
      sourceText,
      authorReplies: (data.authorReplies || []).filter(Boolean),
      images: data.images || [],
      videos: data.videos || [],
      hasVideo: !!data.hasVideo,
      exactUrl: !!data.exactUrl,
    };
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

module.exports = { expandReplies, collectPostDetailsRaw };
