const benchmark = require('./benchmarkAccounts');

const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(value || '').split(/[?#]/)[0];
  }
}

function isThreadsCdnImage(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.includes('cdninstagram.com') || host.includes('fbcdn.net') || host.includes('threads.com') || host.includes('threads.net');
  } catch {
    return false;
  }
}

async function scrapeStrictPostMedia(postUrl) {
  const playwright = require('playwright');
  let browser;
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
    page.setDefaultTimeout(16000);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(2200);

    const result = await page.evaluate(({ sourceUrl }) => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const canonical = (href) => {
        try {
          const u = new URL(href, location.origin);
          return `${u.origin}${u.pathname}`;
        } catch {
          return String(href || '').split(/[?#]/)[0];
        }
      };
      const target = canonical(sourceUrl);
      const overlap = (a, b) => {
        const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const inter = x * y;
        if (!inter) return 0;
        return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
      };
      const postLinks = (root) => root
        ? [...new Set([...root.querySelectorAll('a[href*="/post/"]')].map((a) => canonical(a.href || '')))]
        : [];
      const findMainRoot = () => {
        let best = null;
        for (const a of document.querySelectorAll('a[href*="/post/"]')) {
          if (canonical(a.href || '') !== target) continue;
          const article = a.closest('article,[role="article"]');
          if (article) {
            const links = postLinks(article);
            if (links.includes(target)) return article;
          }
          let node = a.parentElement;
          for (let i = 0; i < 9 && node; i++, node = node.parentElement) {
            const links = postLinks(node);
            const text = clean(node.innerText || '');
            if (links.length === 1 && links[0] === target && text.length <= 5000) best = node;
            if (links.length > 1 && best) break;
          }
        }
        return best;
      };

      const root = findMainRoot();
      if (!root) return { foundRoot: false, images: [], videos: [], hasVideo: false };

      const videoEls = [...root.querySelectorAll('video')].filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= 160 && r.height >= 160;
      });
      const videoRects = videoEls.map((v) => v.getBoundingClientRect());
      const videos = [];
      const addVideo = (v) => {
        const s = String(v || '').trim();
        if (/^https?:\/\//i.test(s) && !videos.includes(s)) videos.push(s);
      };
      for (const v of videoEls) {
        addVideo(v.currentSrc);
        addVideo(v.src);
        for (const s of v.querySelectorAll('source[src]')) addVideo(s.src || s.getAttribute('src'));
      }

      const images = [];
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        const alt = String(img.alt || '').toLowerCase();
        const r = img.getBoundingClientRect();
        if (!src || r.width < 180 || r.height < 180) continue;
        if (/profile|프로필|avatar|사용자/.test(alt)) continue;
        if (img.closest('video')) continue;
        if (videoRects.some((vr) => overlap(r, vr) >= 0.45)) continue;
        if (!images.includes(src)) images.push(src);
      }

      return {
        foundRoot: true,
        images: images.slice(0, 10),
        videos: videos.slice(0, 5),
        hasVideo: videoEls.length > 0,
      };
    }, { sourceUrl: postUrl });

    await context.close();
    return result;
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

benchmark.collectPostDetails = async function strictCollectPostDetails(url, username) {
  const details = await previousCollectPostDetails(url, username);
  const strict = await scrapeStrictPostMedia(url);

  if (!strict?.foundRoot) {
    throw new Error('Threads 원본 게시물 미디어 영역을 정확히 식별하지 못했습니다');
  }

  const strictImages = (strict.images || []).filter(isThreadsCdnImage);
  const originalVideos = Array.isArray(details?.videos) ? details.videos.filter(Boolean) : [];
  const strictVideos = Array.isArray(strict.videos) ? strict.videos.filter(Boolean) : [];
  const videos = strict.hasVideo ? [...new Set([...strictVideos, ...originalVideos])].slice(0, 5) : [];

  if (!strictImages.length && !videos.length) {
    throw new Error('Threads 원본에서 사용 가능한 사진/영상을 확인하지 못했습니다');
  }

  console.log(`[Threads][STRICT MEDIA] @${username || '-'} source=${canonicalUrl(url)} images=${strictImages.length} videos=${videos.length} hasVideo=${strict.hasVideo ? 'yes' : 'no'}`);

  return {
    ...details,
    images: strictImages,
    videos,
    hasVideo: videos.length > 0,
    exactUrl: true,
  };
};

// scheduler가 Threads 미디어 캐시/영상 import에 실패했을 때 쿠팡 상품 이미지로 빠지는 것을 막는다.
// preload 시점에 autopilotMaterialEngine을 먼저 로드해 scheduler가 이 래퍼를 참조하도록 한다.
const autopilot = require('./autopilotMaterialEngine');
const previousBuild = autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot = async function strictThreadsFirstAutopilot(accountId, options) {
  const result = await previousBuild(accountId, options);
  const images = Array.isArray(result?.sourceImages) ? result.sourceImages.filter(Boolean) : [];
  const videos = Array.isArray(result?.sourceVideos) ? result.sourceVideos.filter(Boolean) : [];
  if (!result?.sourceUrl || (!images.length && !videos.length)) {
    throw new Error('Threads 원본 미디어가 없는 소재는 자동발행하지 않습니다');
  }
  if (result.product && typeof result.product === 'object') {
    result.product = { ...result.product, image: '' };
  }
  console.log(`[Autopilot][STRICT THREADS MEDIA] source=${result.sourceUrl} images=${images.length} videos=${videos.length} externalFallback=disabled`);
  return result;
};

console.log('[Threads][STRICT MEDIA PATCH] 원본 Threads 게시물 사진/영상만 사용 · 영상 겹침 이미지 제거 · 쿠팡 이미지 fallback 차단');
