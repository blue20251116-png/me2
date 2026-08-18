const benchmark = require('./benchmarkAccounts');

const originalCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonical(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    u.pathname = u.pathname.replace(/\/media\/?$/i, '').replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw || '').split(/[?#]/)[0].replace(/\/media\/?$/i, '');
  }
}

async function collectFallbackDetails(url, username) {
  let sourceText = '';
  let images = [];
  let videos = [];
  let hasVideo = false;
  let authorReplies = [];

  // 1) 프로필 목록에서 이미 읽었던 원문/미디어를 다시 활용한다.
  try {
    const posts = await benchmark.collectProfilePosts(username, { limit: 20 });
    const target = canonical(url);
    const hit = (posts || []).find(p => canonical(p?.url) === target);
    if (hit) {
      sourceText = String(hit.text || '').replace(/\s+/g, ' ').trim();
      images = Array.isArray(hit.images) ? hit.images.filter(Boolean) : [];
      hasVideo = !!hit.hasVideo || Number(hit.videoCount || 0) > 0;
    }
  } catch (err) {
    console.warn(`[Threads][TEXT FALLBACK] profile 재조회 실패 @${username}: ${err.message}`);
  }

  // 2) 상세 페이지를 새 브라우저로 열어 body/meta/작성자 댓글을 느슨하게 수집한다.
  let browser;
  try {
    const playwright = require('playwright');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1100, height: 1600 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(16000);
    await page.goto(canonical(url), { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 850);
      await page.waitForTimeout(350);
    }

    const data = await page.evaluate(({ username }) => {
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const targetUser = String(username || '').toLowerCase();
      const sameUser = href => {
        try {
          const u = new URL(href, location.origin);
          return u.pathname.toLowerCase().replace(/\/$/, '') === `/@${targetUser}`;
        } catch { return false; }
      };
      const addUnique = (arr, value) => {
        const s = String(value || '').trim();
        if (s && !arr.includes(s)) arr.push(s);
      };
      const externalFrom = root => {
        const out = [];
        if (!root) return out;
        for (const a of root.querySelectorAll('a[href]')) {
          try {
            const u = new URL(a.href || a.getAttribute('href') || '', location.origin);
            if (!/(^|\.)threads\.(com|net)$/i.test(u.hostname)) addUnique(out, u.href);
            for (const key of ['u','url','target','redirect','redirect_url']) {
              const v = u.searchParams.get(key);
              if (!v) continue;
              try { addUnique(out, decodeURIComponent(v)); } catch { addUnique(out, v); }
            }
          } catch {}
        }
        const matches = clean(root.innerText || '').match(/https?:\/\/[^\s)\]}>,]+/gi) || [];
        for (const m of matches) addUnique(out, m);
        return out;
      };
      const compactRoot = anchor => {
        const article = anchor.closest('article,[role="article"]');
        if (article) return article;
        let node = anchor.parentElement, best = null;
        for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
          const text = clean(node.innerText || '');
          if (text.length >= 8 && text.length <= 6000) best = node;
          if (text.length > 6000 && best) break;
        }
        return best;
      };

      const meta = clean(
        document.querySelector('meta[property="og:description"]')?.content ||
        document.querySelector('meta[name="description"]')?.content || ''
      );
      const body = clean(document.body?.innerText || '').slice(0, 8000);
      const imgs = [];
      for (const img of document.querySelectorAll('img')) {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        const alt = String(img.alt || '').toLowerCase();
        if (!src || r.width < 160 || r.height < 160) continue;
        if (/profile|프로필|avatar|사용자/.test(alt)) continue;
        addUnique(imgs, src);
      }
      const vids = [];
      for (const v of document.querySelectorAll('video')) {
        addUnique(vids, v.currentSrc || v.src || v.getAttribute('src'));
      }

      const replies = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        if (!sameUser(a.href || a.getAttribute('href') || '')) continue;
        const root = compactRoot(a);
        if (!root) continue;
        const text = clean(root.innerText || '').slice(0, 4000);
        const links = externalFrom(root);
        const merged = [text, ...links].filter(Boolean).join('\n').slice(0, 6000);
        if (merged.length < 8 || seen.has(merged)) continue;
        seen.add(merged);
        replies.push(merged);
      }

      return {
        meta,
        body,
        images: imgs.slice(0, 10),
        videos: vids.slice(0, 5),
        authorReplies: replies.slice(0, 15),
        videoCount: document.querySelectorAll('video').length,
      };
    }, { username });

    if (!sourceText) {
      sourceText = String(data.meta || '').trim();
      if (!sourceText) {
        // body 전체를 원문으로 쓰지는 않고, 프로필 fallback도 실패한 경우에만 최소 텍스트를 보조로 남긴다.
        sourceText = String(data.body || '').trim().slice(0, 1800);
      }
    }
    if (!images.length && Array.isArray(data.images)) images = data.images.filter(Boolean);
    videos = Array.isArray(data.videos) ? data.videos.filter(Boolean) : [];
    hasVideo = hasVideo || videos.length > 0 || Number(data.videoCount || 0) > 0;
    authorReplies = Array.isArray(data.authorReplies) ? data.authorReplies.filter(Boolean) : [];

    await context.close();
  } catch (err) {
    console.warn(`[Threads][TEXT FALLBACK] browser 재조회 실패 @${username}: ${err.message}`);
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }

  console.log(`[Threads][TEXT FALLBACK] @${username} source=${sourceText.length} replies=${authorReplies.length} images=${images.length} videos=${videos.length} hasVideo=${hasVideo ? 'yes' : 'no'}`);
  return {
    sourceText,
    authorReplies,
    images,
    videos,
    hasVideo,
    exactUrl: true,
  };
}

benchmark.collectPostDetails = async function patchedCollectPostDetails(url, username) {
  try {
    return await originalCollectPostDetails(url, username);
  } catch (err) {
    const msg = String(err?.message || '');
    if (!/Threads 원문 텍스트를 읽지 못했습니다/i.test(msg)) throw err;
    console.warn(`[Threads][TEXT FALLBACK] 원문 직접 추출 실패 → fallback @${username} source=${url}`);
    return collectFallbackDetails(url, username);
  }
};

console.log('[Threads][TEXT FALLBACK PATCH] 원문 상세 추출 실패 시 프로필/브라우저 fallback 활성화');
