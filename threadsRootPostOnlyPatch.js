const benchmark = require('./benchmarkAccounts');

const previous = benchmark.collectPostDetails.bind(benchmark);

function normalizePostUrl(url) {
  return String(url || '').replace(/\/media(?:[?#].*)?$/i, '').split(/[?#]/)[0].replace(/\/$/, '');
}

async function collectRootPost(url, username) {
  const playwright = require('playwright');
  let browser, context;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
    context = await browser.newContext({
      locale: 'ko-KR', viewport: { width: 1100, height: 1500 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(16000);
    const target = normalizePostUrl(url);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(2200);

    // 중요: 댓글을 펼치거나 스크롤하기 전에 화면 최상단의 원작성자 본문 블록을 고정한다.
    const data = await page.evaluate(({ username }) => {
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const user = String(username || '').toLowerCase();
      const isAuthorLink = a => {
        try {
          const u = new URL(a.href || a.getAttribute('href') || '', location.origin);
          return u.pathname.toLowerCase().replace(/\/$/, '') === `/@${user}`;
        } catch { return false; }
      };
      const isProfile = (src, alt='') => /(?:t51\.82787-19|profile|프로필|avatar|사용자|s150x150|150x150)/i.test(`${src} ${alt}`);
      const isShop = src => /coupang|shopping\.naver|smartstore|\/emg1\//i.test(String(src || ''));

      // 상세 페이지에서 같은 작성자가 댓글을 달아도 본문이 항상 댓글보다 위에 있다.
      // 따라서 "링크가 있는 블록"이 아니라, 원작성자 블록 중 화면상 가장 위의 독립 article을 본문으로 선택한다.
      const candidates = [];
      for (const article of document.querySelectorAll('article,[role="article"]')) {
        const author = [...article.querySelectorAll('a[href]')].some(isAuthorLink);
        if (!author) continue;
        const r = article.getBoundingClientRect();
        const text = clean(article.innerText || '');
        if (text.length < 5 || r.width < 250) continue;
        candidates.push({ article, top: r.top, textLength: text.length });
      }
      candidates.sort((a,b) => a.top - b.top);
      let main = candidates[0]?.article || null;

      // article 마크업이 없는 Threads 변형 UI용 fallback: 작성자 링크 중 가장 위쪽 것을 기준으로 작은 컨테이너 선택.
      if (!main) {
        const anchors = [...document.querySelectorAll('a[href]')].filter(isAuthorLink)
          .map(a => ({ a, top: a.getBoundingClientRect().top })).sort((a,b)=>a.top-b.top);
        const anchor = anchors[0]?.a;
        if (anchor) {
          let node = anchor.parentElement, best = null;
          for (let i=0; i<10 && node; i++, node=node.parentElement) {
            const r=node.getBoundingClientRect(), text=clean(node.innerText||'');
            if (r.width >= 300 && text.length >= 5 && text.length <= 5000) best=node;
            if (best && text.length > 5000) break;
          }
          main = best;
        }
      }

      const images=[], videos=[];
      if (main) {
        for (const v of main.querySelectorAll('video')) {
          const r=v.getBoundingClientRect();
          if (r.width < 160 || r.height < 160) continue;
          const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';
          if (src && !videos.includes(src)) videos.push(src);
        }
        for (const img of main.querySelectorAll('img')) {
          const r=img.getBoundingClientRect();
          const src=img.currentSrc||img.src||'';
          const alt=img.alt||'';
          if (!src || r.width < 160 || r.height < 160) continue;
          if (isProfile(src,alt) || isShop(src)) continue;
          if (img.closest('video')) continue;
          if (!images.includes(src)) images.push(src);
        }
      }
      const meta = clean(document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || '');
      return {
        found: !!main,
        sourceText: clean(main?.innerText || meta).slice(0,5000),
        images: images.slice(0,10), videos: videos.slice(0,5), hasVideo: videos.length>0,
        candidateCount: candidates.length
      };
    }, { username });

    console.log(`[Threads][ROOT POST ONLY V2] @${username} found=${data.found?'yes':'no'} candidates=${data.candidateCount} images=${data.images.length} videos=${data.videos.length} commentsMedia=ignored`);
    return data;
  } finally {
    if (context) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
  }
}

benchmark.collectPostDetails = async function rootPostOnly(url, username) {
  let base = null;
  try { base = await previous(url, username); } catch (err) {
    console.warn(`[Threads][ROOT POST ONLY V2] base detail failed @${username}: ${String(err?.message || err)}`);
  }

  // 캐시에 실제 본문 미디어가 있으면 그대로 사용. 없을 때만 원게시물 최상단 블록을 다시 읽는다.
  if ((base?.images?.length || 0) > 0 || (base?.videos?.length || 0) > 0) return base;

  const root = await collectRootPost(url, username);
  const sourceText = String(root.sourceText || base?.sourceText || '').trim();
  if (!sourceText) throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');

  return {
    ...(base || {}),
    sourceText,
    // 미디어는 오직 원게시물에서만. 댓글/쿠팡 프리뷰 미디어는 절대 합치지 않는다.
    images: root.images || [],
    videos: root.videos || [],
    hasVideo: !!root.hasVideo,
    exactUrl: true,
    mediaScope: 'root-post-only',
    // 링크/댓글 텍스트는 기존 수집 결과를 유지하되 미디어와 분리한다.
    authorReplies: base?.authorReplies || [],
    affiliateLinks: base?.affiliateLinks || []
  };
};

console.log('[Threads][ROOT POST ONLY PATCH V2] 사진/영상=원게시물 최상단 작성자 블록만 · 작성자 댓글=링크/텍스트만');
