const { db } = require('./db');

// Same crash-at-boot class of bug found and fixed across db.js/bootstrap.js/server.js/
// automationState.js/sessionStore.js during the 2026-09-12 persistent-volume-full incident: this
// ran completely unguarded at module load.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads_benchmark_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS threads_benchmark_used_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_url TEXT NOT NULL UNIQUE,
      used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
} catch (e) {
  console.error('[BenchmarkAccounts][INIT] 테이블 생성 실패 (디스크 문제로 추정) - 프로세스는 계속 부팅합니다:', e.message);
}

function normalizeUsername(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  try {
    if (/^https?:\/\//i.test(v)) {
      const u = new URL(v);
      const m = u.pathname.match(/^\/@?([^/]+)/);
      if (m) v = m[1];
    }
  } catch {}
  v = v.replace(/^@+/, '').split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9._]{1,64}$/.test(v) ? v : '';
}

function parseUsernames(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value || '');
  return [...new Set(raw.split(/[\s,;]+/).map(normalizeUsername).filter(Boolean))];
}

function listBenchmarkAccounts() {
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();
}
function addBenchmarkAccount(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('올바른 Threads 아이디를 입력해주세요.');
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username=?').get(username);
}
function addBenchmarkAccountsBulk(value) {
  const usernames = parseUsernames(value);
  if (!usernames.length) throw new Error('등록할 Threads 아이디가 없습니다.');
  const insert = db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');
  let added = 0, skipped = 0;
  for (const username of usernames) {
    const info = insert.run(username);
    if (Number(info?.changes || 0) > 0) added++; else skipped++;
  }
  return { added, skipped, total: usernames.length, accounts: listBenchmarkAccounts() };
}
function deleteBenchmarkAccount(id) { return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id=?').run(Number(id)); }
function markUsedPost(url) { return; }
function isUsedPost(url) { return false; }
function shuffle(items) { const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

async function openBrowser() {
  const playwright = require('playwright');
  const browser = await playwright.chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
  const __threadsFs=require('fs');
  const __threadsPath=require('path');
  const statePath=process.env.THREADS_STORAGE_STATE_PATH||'/app/db/threads-storage-state.json';
  let storageState=null;
  try {
    if (__threadsFs.existsSync(statePath)) storageState=JSON.parse(__threadsFs.readFileSync(statePath,'utf8'));
    else if (process.env.THREADS_STORAGE_STATE_JSON) { storageState=JSON.parse(process.env.THREADS_STORAGE_STATE_JSON); __threadsFs.mkdirSync(__threadsPath.dirname(statePath),{recursive:true}); __threadsFs.writeFileSync(statePath,JSON.stringify(storageState),{mode:0o600}); }
  } catch(e) { console.error('[Threads][SESSION] storageState load failed:',e.message); storageState=null; }
  const context = await browser.newContext({ locale:'ko-KR', viewport:{width:1100,height:1500}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', ...(storageState?{storageState}:{}) });
  context.__threadsStatePath=statePath; context.__threadsStateHealthy=false;
  const originalClose=context.close.bind(context);
  context.close=async()=>{
    if(context.__threadsStateHealthy){ try { __threadsFs.mkdirSync(__threadsPath.dirname(statePath),{recursive:true}); await context.storageState({path:statePath}); try{__threadsFs.chmodSync(statePath,0o600);}catch{} console.log('[Threads][SESSION] healthy state persisted'); } catch(e){ console.error('[Threads][SESSION] storageState save failed:',e.message); } }
    else console.warn('[Threads][SESSION] challenged/unverified context · existing persistent state preserved');
    return originalClose();
  };
  console.log(`[Threads][SESSION] collector session=${storageState?'RESTORED':'ANONYMOUS'} path=${statePath}`);
  return { browser, context };
}

async function collectProfilePostsWithContext(context, username, {limit=2}={}) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(12000);
    await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`, { waitUntil:'domcontentloaded', timeout:12000 });
    await page.waitForTimeout(1600);
    const scrollRounds=Math.max(6,Math.min(24,Math.ceil(Number(limit||2)/2)+4));
    for (let i=0;i<scrollRounds;i++) {
      await page.mouse.wheel(0,1200);
      await page.waitForTimeout(i<4?350:220);
    }
    const __profileDiag=await page.evaluate(()=>({ finalUrl:location.href, title:String(document.title||'').slice(0,160), anchors:document.querySelectorAll('a').length, postLinks:document.querySelectorAll('a[href*="/post/"]').length, articles:document.querySelectorAll('article,[role="article"]').length, hrefSamples:[...document.querySelectorAll('a[href]')].map(a=>{try{return new URL(a.href,location.origin).pathname}catch{return ''}}).filter(Boolean).slice(0,12), bodyText:String(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,220) }));
    const __profileResult=await page.evaluate(({username,limit}) => {
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};
      const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};
      const findRoot=(a,target)=>{
        const article=a.closest('article,[role="article"]');
        if(article&&clean(article.innerText).length>=8)return article;
        let node=a.parentElement,best=null;
        for(let i=0;i<9&&node;i++,node=node.parentElement){
          const txt=clean(node.innerText);
          if(txt.length<8)continue;
          const links=[...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href));
          const uniq=[...new Set(links)];
          if(uniq.length===1&&uniq[0]===target&&txt.length<=5000)best=node;
          if(uniq.length>1&&best)break;
        }
        return best;
      };
      const mediaFromRoot=(root,target)=>{
        if(!root)return{images:[],hasVideo:false,videoCount:0};
        const videos=[...root.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>=180&&r.height>=180;});
        const videoRects=videos.map(v=>v.getBoundingClientRect());
        const images=[];
        for(const img of root.querySelectorAll('img')){
          const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();
          if(!src||r.width<180||r.height<180)continue;
          if(/profile|프로필|avatar|사용자/.test(alt))continue;
          const nestedArticle=img.closest('article,[role="article"]');
          if(nestedArticle&&nestedArticle!==root)continue;
          const postAnchor=img.closest('a[href*="/post/"]');
          if(postAnchor&&canonical(postAnchor.href||'')!==target)continue;
          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;
          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;
          if(!images.includes(src))images.push(src);
        }
        return{images:images.slice(0,10),hasVideo:videos.length>0,videoCount:videos.length};
      };
      const out=[],seen=new Set();
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        if(out.length>=limit)break;
        const href=canonical(a.href||'');
        if(!href||seen.has(href))continue;
        seen.add(href);
        let p='';try{p=new URL(href).pathname;}catch{}
        if(!/\/post\//i.test(p))continue;
        const root=findRoot(a,href);if(!root)continue;
        const text=clean(root.innerText||'').slice(0,1800);if(text.length<8)continue;
        const media=mediaFromRoot(root,href);
        out.push({url:href,text,username,images:media.images,thumbnail:media.images[0]||'',imageCount:media.images.length,hasVideo:media.hasVideo,videoCount:media.videoCount});
      }
      return out;
    }, {username,limit});
    const __login=/\/login\//i.test(__profileDiag.finalUrl)||/Threads\s*[•·]\s*로그인/i.test(__profileDiag.title);
    const __errorShell=/문제가 발생했습니다|나중에 다시 시도/i.test(__profileDiag.bodyText);
    const __challenged=__login||__errorShell;
    if(__profileResult.length&&!__challenged) context.__threadsStateHealthy=true;
    if(__challenged) Object.defineProperty(__profileResult,'__threadsChallenge',{value:true,enumerable:false});
    const __diagMsg=`@${username} final=${__profileDiag.finalUrl} title=${JSON.stringify(__profileDiag.title)} postLinks=${__profileDiag.postLinks} anchors=${__profileDiag.anchors} articles=${__profileDiag.articles} hrefs=${JSON.stringify(__profileDiag.hrefSamples)} body=${JSON.stringify(__profileDiag.bodyText)}`;
    if(__profileResult.length&&!__challenged) console.log(`[Threads][PROFILE OK] ${__diagMsg} posts=${__profileResult.length}`); else console.error(`[Threads][PROFILE ${__challenged?'CHALLENGED':'EMPTY'}] ${__diagMsg}`);
    return __profileResult;
  } finally { try{await page.close();}catch{} }
}

async function collectProfilePosts(username,{limit=2}={}) {
  let browser,context;
  try { ({browser,context}=await openBrowser()); return await collectProfilePostsWithContext(context,username,{limit}); }
  finally { if(context)try{await context.close();}catch{} if(browser)try{await browser.close();}catch{} }
}

async function expandReplies(page) {
  for (let round=0; round<5; round++) {
    let clicked=0;
    try {
      clicked=await page.evaluate(() => {
        const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
        const re=/(답글\s*(?:보기|더\s*보기)|댓글\s*(?:보기|더\s*보기)|답글\s*\d+개|댓글\s*\d+개|view\s+(?:more\s+)?repl(?:y|ies)|more\s+repl(?:y|ies))/i;
        let n=0;
        for(const el of document.querySelectorAll('button,[role="button"],a')){
          if(n>=12)break;
          const t=clean(el.innerText||el.textContent||'');
          if(!t||t.length>80||!re.test(t))continue;
          try{el.click();n++;}catch{}
        }
        return n;
      });
    } catch {}
    await page.mouse.wheel(0,850);
    await page.waitForTimeout(clicked?650:350);
    if(!clicked&&round>=2)break;
  }
}

async function collectPostDetailsRaw(url, username) {
  let browser,context;
  try {
    ({browser,context}=await openBrowser());
    const page=await context.newPage();
    page.setDefaultTimeout(16000);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:16000});
    await page.waitForTimeout(1800);
    await expandReplies(page);
    await page.mouse.wheel(0,1000);
    await page.waitForTimeout(500);

    const data=await page.evaluate(({username,sourceUrl})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};
      const targetUrl=canonical(sourceUrl),targetUser=String(username||'').toLowerCase();
      const sameUserHref=href=>{
        try {
          const u=new URL(href,location.origin);
          return u.pathname.toLowerCase().replace(/\/$/,'')===`/@${targetUser}`;
        } catch { return false; }
      };
      function externalTargetsFromHref(raw){
        const out=[];
        const add=v=>{const s=String(v||'').trim();if(/^https?:\/\//i.test(s)&&!out.includes(s))out.push(s);};
        try{
          const u=new URL(raw,location.origin);
          if(!/(^|\.)threads\.(com|net)$/i.test(u.hostname))add(u.href);
          for(const key of['u','url','target','redirect','redirect_url']){
            const v=u.searchParams.get(key);
            if(!v)continue;
            try{add(decodeURIComponent(v));}catch{add(v);}
          }
        }catch{}
        return out;
      }
      function externalLinksFromRoot(root){
        if(!root)return[];
        const out=[];
        for(const a of root.querySelectorAll('a[href]')){
          for(const u of externalTargetsFromHref(a.href||a.getAttribute('href')||''))if(!out.includes(u))out.push(u);
        }
        const txt=clean(root.innerText||'');
        const matches=txt.match(/https?:\/\/[^\s)\]}>,]+/gi)||[];
        for(const u of matches)if(!out.includes(u))out.push(u);
        return out.slice(0,12);
      }
      function compactRoot(anchor){
        const article=anchor.closest('article,[role="article"]');
        if(article)return article;
        let node=anchor.parentElement,best=null;
        for(let i=0;i<9&&node;i++,node=node.parentElement){
          const text=clean(node.innerText||'');
          if(text.length<8)continue;
          if(text.length<=5000)best=node;
          if(text.length>5000&&best)break;
        }
        return best;
      }
      function postLinks(root){return root?[...new Set([...root.querySelectorAll('a[href*="/post/"]')].map(a=>canonical(a.href||'')))]:[];}
      function isMainRoot(root){return !!root&&postLinks(root).includes(targetUrl);}
      function replyTextWithLinks(root){
        const text=clean(root?.innerText||'').slice(0,4000);
        const links=externalLinksFromRoot(root);
        return [text,...links].filter(Boolean).join('\n').slice(0,6000);
      }

      let main=null;
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        if(canonical(a.href||'')!==targetUrl)continue;
        const root=compactRoot(a);
        if(!root)continue;
        if(!main||clean(root.innerText).length<clean(main.innerText).length)main=root;
      }
      const metaDescription=clean(document.querySelector('meta[property="og:description"]')?.content||document.querySelector('meta[name="description"]')?.content||'');
      const sourceText=clean(main?.innerText||metaDescription||'').slice(0,5000);

      const images=[],videos=[];
      if(main){
        const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};
        const videoEls=[...main.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>=160&&r.height>=160;});
        const videoRects=videoEls.map(v=>v.getBoundingClientRect());
        for(const v of videoEls){const src=v.currentSrc||v.src||'';if(src&&!videos.includes(src))videos.push(src);}
        for(const img of main.querySelectorAll('img')){
          const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();
          const r=img.getBoundingClientRect();
          if(!src||r.width<160||r.height<160)continue;
          if(/profile|프로필|avatar|사용자/.test(alt))continue;
          const nestedArticle=img.closest('article,[role="article"]');
          if(nestedArticle&&nestedArticle!==main)continue;
          const postAnchor=img.closest('a[href*="/post/"]');
          if(postAnchor&&canonical(postAnchor.href||'')!==targetUrl)continue;
          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;
          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;
          if(!images.includes(src))images.push(src);
        }
      }

      const authorReplies=[],seen=new Set(),authorRoots=new Set();
      const authorAnchors=[...document.querySelectorAll('a[href]')].filter(a=>sameUserHref(a.href||a.getAttribute('href')||''));
      for(const a of authorAnchors){
        const root=compactRoot(a);
        if(!root||root===main||isMainRoot(root))continue;
        authorRoots.add(root);
      }
      for(const block of document.querySelectorAll('article,[role="article"]')){
        if(block===main||isMainRoot(block))continue;
        const anchors=[...block.querySelectorAll('a[href]')];
        if(anchors.some(a=>sameUserHref(a.href||a.getAttribute('href')||'')))authorRoots.add(block);
      }
      for(const root of authorRoots){
        const reply=replyTextWithLinks(root);
        if(!reply||reply.length<8||seen.has(reply))continue;
        seen.add(reply);
        authorReplies.push(reply);
      }

      const allAffiliateLinks=[];
      for(const reply of authorReplies){
        const matches=reply.match(/https?:\/\/[^\s)\]}>,]+/gi)||[];
        for(const m of matches){if(/coupang|naver/i.test(m)&&!allAffiliateLinks.includes(m))allAffiliateLinks.push(m);}
      }
      return{
        sourceText,
        authorReplies:authorReplies.slice(0,15),
        images:images.slice(0,10),
        videos:videos.slice(0,5),
        hasVideo:videos.length>0,
        exactUrl:canonical(location.href)===targetUrl,
        metaDescription,
        authorAnchorCount:authorAnchors.length,
        authorRootCount:authorRoots.size,
        affiliateLinkCount:allAffiliateLinks.length
      };
    },{username,sourceUrl:url});

    const sourceText=String(data.sourceText||data.metaDescription||'').trim();
    if(!sourceText)throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
    console.log(`[Threads detail] @${username} source=${sourceText.length} replies=${(data.authorReplies||[]).length} authorAnchors=${data.authorAnchorCount||0} authorRoots=${data.authorRootCount||0} affiliateLinks=${data.affiliateLinkCount||0} images=${(data.images||[]).length} videos=${(data.videos||[]).length}`);
    return{
      sourceText,
      authorReplies:(data.authorReplies||[]).filter(Boolean),
      images:data.images||[],
      videos:data.videos||[],
      hasVideo:!!data.hasVideo,
      exactUrl:!!data.exactUrl
    };
  } finally {
    if(context)try{await context.close();}catch{}
    if(browser)try{await browser.close();}catch{}
  }
}

// ---------- collectPostDetails guard layers ----------
// These used to be 3 separate files monkey-patching benchmark.collectPostDetails in sequence,
// composed differently per process:
//  - worker process (ME2_BROWSER_WORKER==='1'): withTextFallback(withVideoExtraction(raw))
//  - main process: with429Guard(withVideoExtraction(isolatedDispatch)), where isolatedDispatch
//    invokes the ENTIRE worker-side chain above in the isolated browser subprocess - so
//    withVideoExtraction's retry runs twice on the round trip (once inside the worker, once again
//    in the main process if the worker's own video extraction came back empty). That double layer
//    is deliberate: it's the retry, not redundancy, so it's preserved exactly below.
function canonicalPostUrl(raw) {
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
function isHttpVideoUrl(value) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(s)) return true;
  if (/fbcdn|cdninstagram|threads|instagram/i.test(s) && /video|mp4|bytestart|byteend|range=/i.test(s)) return true;
  return false;
}
function mediaViewUrl(raw) { return `${canonicalPostUrl(raw).replace(/\/+$/, '')}/media`; }
async function videoFallbackFromProfile(url, username) {
  try {
    const posts = await collectProfilePosts(username, { limit: 30 });
    const target = canonicalPostUrl(url);
    const hit = (posts || []).find(p => canonicalPostUrl(p?.url) === target);
    if (!hit) return null;
    const sourceText = String(hit.text || '').replace(/\s+/g, ' ').trim();
    const images = Array.isArray(hit.images) ? hit.images.filter(Boolean) : [];
    const hasVideo = !!hit.hasVideo || Number(hit.videoCount || 0) > 0;
    console.log(`[Threads][EARLY TEXT FALLBACK] @${username || '-'} source=${sourceText.length} images=${images.length} hasVideo=${hasVideo ? 'yes' : 'no'}`);
    return { sourceText, authorReplies: [], images, videos: [], hasVideo, exactUrl: true };
  } catch (err) {
    console.warn(`[Threads][EARLY TEXT FALLBACK] 실패 @${username || '-'} reason="${err.message}"`);
    return null;
  }
}
async function extractPlayableVideoUrls(postUrl) {
  const playwright = require('playwright');
  let browser;
  const found = [];
  const add = url => {
    const s = String(url || '').trim();
    if (!isHttpVideoUrl(s)) return;
    if (!found.includes(s)) found.push(s);
  };

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    });
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1100, height: 1500 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });

    const scan = async (targetUrl, { allow429Fallback = false } = {}) => {
      const page = await context.newPage();
      page.setDefaultTimeout(16000);
      page.on('request', request => add(request.url()));
      page.on('response', async response => {
        try {
          const status = response.status();
          const url = response.url();
          const request = response.request();
          const resourceType = request.resourceType();
          const headers = await response.allHeaders().catch(() => ({}));
          const type = String(headers['content-type'] || '').toLowerCase();

          if (status === 429) {
            console.warn(`[Threads][429 TRACE] stage=subresponse status=429 resource=${resourceType || '-'} url=${url} retryAfter=${headers['retry-after'] || '-'} contentType=${type || '-'}`);
            return;
          }

          if (type.startsWith('video/') || type.includes('octet-stream') || isHttpVideoUrl(url)) add(url);
        } catch (err) {
          console.warn(`[Threads][429 TRACE ERROR] stage=subresponse reason="${err.message}"`);
        }
      });

      try {
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 16000 });
        const status=response?.status?.()??0;
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};
        console.log(`[Threads][VIDEO PAGE] status=${status || '-'} url=${targetUrl} retryAfter=${headers['retry-after'] || '-'} server=${headers['server'] || '-'}`);

        if(status===429){
          console.warn(`[Threads][429 TRACE] stage=page-goto status=429 resource=document url=${targetUrl} retryAfter=${headers['retry-after'] || '-'} contentType=${headers['content-type'] || '-'}`);
          if (allow429Fallback) {
            console.warn(`[Threads][VIDEO EXTRACT SCAN] status=429 url=${targetUrl} → 이 게시물만 /media 1회 fallback 시도`);
            return { ok:false, status:429 };
          }
          console.warn(`[Threads][VIDEO EXTRACT SCAN] status=429 url=${targetUrl} → 해당 소재만 실패 처리`);
          return { ok:false, status:429 };
        }

        await page.waitForTimeout(2200);
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, 650);
          await page.waitForTimeout(250);
        }
        try {
          const video = page.locator('video').first();
          if (await video.count()) {
            await video.scrollIntoViewIfNeeded().catch(() => {});
            await video.click({ force: true, timeout: 1200 }).catch(() => {});
          }
        } catch {}
        try {
          await page.evaluate(() => {
            for (const v of document.querySelectorAll('video')) {
              try { v.muted = true; v.load?.(); v.play().catch(() => {}); } catch {}
            }
          });
        } catch {}
        try {
          const playButtons = page.getByRole('button', { name: /play|재생/i });
          const n = Math.min(await playButtons.count(), 3);
          for (let i = 0; i < n; i++) await playButtons.nth(i).click({ force: true, timeout: 1000 }).catch(() => {});
        } catch {}
        await page.waitForTimeout(3500);

        const domUrls = await page.evaluate(() => {
          const out = [];
          const add = v => { const s = String(v || '').trim(); if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s); };
          for (const v of document.querySelectorAll('video')) {
            add(v.currentSrc); add(v.src); add(v.getAttribute('src'));
            for (const s of v.querySelectorAll('source[src]')) add(s.src || s.getAttribute('src'));
            for (const key of ['data-src','data-video-url','data-url','data-playable-url']) add(v.getAttribute(key));
          }
          for (const selector of [
            'meta[property="og:video"]','meta[property="og:video:url"]','meta[property="og:video:secure_url"]','meta[name="twitter:player:stream"]'
          ]) add(document.querySelector(selector)?.content);
          try { for (const e of performance.getEntriesByType('resource')) add(e?.name); } catch {}
          return out;
        });
        for (const u of domUrls) add(u);

        try {
          const html = await page.content();
          const patterns = [
            /"video_url"\s*:\s*"([^"]+)"/gi,
            /"playable_url"\s*:\s*"([^"]+)"/gi,
            /"playable_url_quality_hd"\s*:\s*"([^"]+)"/gi,
            /"browser_native_hd_url"\s*:\s*"([^"]+)"/gi,
            /"progressive_url"\s*:\s*"([^"]+)"/gi,
            /(https?:\\?\/\\?\/[^"'<>\s]+?\.mp4[^"'<>\s]*)/gi,
          ];
          const decode = s => String(s || '').replace(/\\u0026/gi,'&').replace(/\\u003d/gi,'=').replace(/\\u002f/gi,'/').replace(/\\\//g,'/');
          for (const re of patterns) { let m; while ((m = re.exec(html)) !== null) add(decode(m[1] || m[0])); }
        } catch {}

        const domVideoCount = await page.locator('video').count().catch(() => 0);
        console.log(`[Threads][VIDEO EXTRACT SCAN] status=${status || '-'} url=${targetUrl} domVideos=${domVideoCount} playable=${found.length}`);
        return { ok:true, status };
      } finally {
        try { await page.close(); } catch {}
      }
    };

    const primary = await scan(canonicalPostUrl(postUrl), { allow429Fallback:true });
    if (!found.length && (primary?.status === 429 || primary?.ok)) {
      const mediaUrl = mediaViewUrl(postUrl);
      console.log(`[Threads][VIDEO MEDIA FALLBACK] start url=${mediaUrl} reason=${primary?.status === 429 ? 'primary-429' : 'primary-no-playable'}`);
      const media = await scan(mediaUrl, { allow429Fallback:false });
      console.log(`[Threads][VIDEO MEDIA FALLBACK] done status=${media?.status || '-'} playable=${found.length} url=${mediaUrl}`);
    }
    await context.close();
  } catch (err) {
    console.warn(`[Threads][VIDEO EXTRACT] fallback 실패 url=${postUrl} reason="${err.message}"`);
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }

  return found.slice(0, 5);
}
function withVideoExtraction(baseFn) {
  return async function collectPostDetailsWithVideo(url, username) {
    let details;
    try {
      details = await baseFn(url, username);
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/Threads 원문 텍스트를 읽지 못했습니다/i.test(msg)) throw err;
      console.warn(`[Threads][EARLY TEXT FALLBACK] 원문 직접 추출 실패 → 프로필 fallback @${username || '-'} source=${url}`);
      details = await videoFallbackFromProfile(url, username);
      if (!details || !String(details.sourceText || '').trim()) throw err;
    }

    const existing = Array.isArray(details?.videos) ? details.videos.filter(isHttpVideoUrl) : [];
    if (existing.length) return { ...details, videos: existing, hasVideo: true };
    if (!details?.hasVideo) return details;

    const videos = await extractPlayableVideoUrls(url);
    console.log(`[Threads][VIDEO EXTRACT] @${username || '-'} detected=${details?.hasVideo ? 'yes' : 'no'} playable=${videos.length}`);
    return { ...details, videos, hasVideo: details?.hasVideo || videos.length > 0 };
  };
}
async function collectFallbackDetails(url, username) {
  let sourceText = '';
  let images = [];
  let videos = [];
  let hasVideo = false;
  let authorReplies = [];

  // 1) 프로필 목록에서 이미 읽었던 원문/미디어를 다시 활용한다.
  try {
    const posts = await collectProfilePosts(username, { limit: 20 });
    const target = canonicalPostUrl(url);
    const hit = (posts || []).find(p => canonicalPostUrl(p?.url) === target);
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
    await page.goto(canonicalPostUrl(url), { waitUntil: 'domcontentloaded', timeout: 16000 });
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
function withTextFallback(baseFn) {
  return async function collectPostDetailsWithTextFallback(url, username) {
    try {
      return await baseFn(url, username);
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/Threads 원문 텍스트를 읽지 못했습니다/i.test(msg)) throw err;
      console.warn(`[Threads][TEXT FALLBACK] 원문 직접 추출 실패 → fallback @${username} source=${url}`);
      return collectFallbackDetails(url, username);
    }
  };
}
const THREADS_429_CACHE_TTL_MS = 20 * 60 * 1000;
const THREADS_429_COOLDOWN_MS = 15 * 60 * 1000;
const threads429DetailCache = new Map();
const threads429Guard = global.__THREADS_WEB_GUARD__ || {
  cooldowns: new Map(),
  mark429(source = '') {
    const key = canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    if (!key) return;
    const until = Date.now() + THREADS_429_COOLDOWN_MS;
    this.cooldowns.set(key, until);
    console.warn(`[Threads][429 GUARD] 429 감지 → 해당 URL만 15분 cooldown source=${source || '-'} key=${key}`);
  },
  isCooling(source = '') {
    const key = canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    if (!key) return false;
    const until = Number(this.cooldowns.get(key) || 0);
    if (until && until <= Date.now()) this.cooldowns.delete(key);
    return Date.now() < until;
  },
  remainingMinutes(source = '') {
    const key = canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    const until = Number(this.cooldowns.get(key) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 60000));
  },
  clearExpired() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (!until || until <= now) this.cooldowns.delete(key);
  },
};
if (!(threads429Guard.cooldowns instanceof Map)) threads429Guard.cooldowns = new Map();
global.__THREADS_WEB_GUARD__ = threads429Guard;
function threads429CloneDetail(value) {
  if (!value) return value;
  return {
    ...value,
    authorReplies: Array.isArray(value.authorReplies) ? [...value.authorReplies] : [],
    images: Array.isArray(value.images) ? [...value.images] : [],
    videos: Array.isArray(value.videos) ? [...value.videos] : [],
  };
}
function is429Error(err) {
  return Number(err?.response?.status || err?.status || 0) === 429 || /(?:status(?: code)?\s*429|\b429\b|too many requests)/i.test(String(err?.message || ''));
}
async function threads429ProfileFallback(url, username) {
  if (!username) return null;
  try {
    const posts = await collectProfilePosts(username, { limit: 30 });
    const target = canonicalPostUrl(url);
    const hit = (posts || []).find(p => canonicalPostUrl(p?.url) === target);
    if (!hit) return null;
    return {
      sourceText: String(hit.text || '').replace(/\s+/g, ' ').trim(),
      authorReplies: [],
      images: Array.isArray(hit.images) ? hit.images.filter(Boolean) : [],
      videos: [],
      hasVideo: !!hit.hasVideo || Number(hit.videoCount || 0) > 0,
      exactUrl: true,
      webCooldownFallback: true,
    };
  } catch (err) {
    console.warn(`[Threads][429 GUARD] profile fallback 실패 @${username || '-'} reason="${err.message}"`);
    return null;
  }
}
function with429Guard(baseFn) {
  return async function collectPostDetailsWith429Guard(url, username) {
    const key = canonicalPostUrl(url);
    const cached = threads429DetailCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[Threads][429 GUARD] detail cache hit @${username || '-'} url=${key}`);
      return threads429CloneDetail(cached.value);
    }
    if (cached) threads429DetailCache.delete(key);

    if (threads429Guard.isCooling(key)) {
      const remain = threads429Guard.remainingMinutes(key);
      console.warn(`[Threads][429 GUARD] 이 URL cooldown ${remain}분 남음 → 상세 직접접근 생략 @${username || '-'} url=${key}`);
      const fallback = await threads429ProfileFallback(key, username);
      if (fallback?.sourceText) {
        threads429DetailCache.set(key, { expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS, value: threads429CloneDetail(fallback) });
        return fallback;
      }
      throw new Error(`Threads 웹 요청 제한 cooldown 중입니다 (${remain}분): ${key}`);
    }

    try {
      const result = await baseFn(url, username);
      if (result) threads429DetailCache.set(key, { expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS, value: threads429CloneDetail(result) });
      return result;
    } catch (err) {
      if (!is429Error(err)) throw err;
      threads429Guard.mark429(key);
      const fallback = await threads429ProfileFallback(key, username);
      if (fallback?.sourceText) {
        threads429DetailCache.set(key, { expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS, value: threads429CloneDetail(fallback) });
        return fallback;
      }
      throw err;
    }
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of threads429DetailCache) if (!item || item.expiresAt <= now) threads429DetailCache.delete(key);
  threads429Guard.clearExpired?.();
}, 10 * 60 * 1000).unref?.();

async function mapWithConcurrency(items,concurrency,worker){
  const results=[];let cursor=0;
  async function run(){while(true){const i=cursor++;if(i>=items.length)return;try{results[i]=await worker(items[i],i);}catch(err){results[i]={error:err};}}}
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));
  return results;
}

async function collectBenchmarkMaterials({limit=10}={}){
  const accounts=shuffle(listBenchmarkAccounts());
  if(!accounts.length)throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');
  const batchSize=Math.max(4,Math.min(12,Number(process.env.THREADS_BENCHMARK_BATCH_SIZE||12)));
  const maxAccounts=Math.max(batchSize,Math.min(accounts.length,Number(process.env.THREADS_BENCHMARK_MAX_SCAN||Math.min(accounts.length,72))));
  let browser,context;
  try{
    ({browser,context}=await openBrowser());
    const all=[],seen=new Set(); let scannedAccounts=0,successfulPools=0,challengeCount=0;
    for(let offset=0;offset<maxAccounts&&all.length<limit;offset+=batchSize){
      const batch=accounts.slice(offset,Math.min(offset+batchSize,maxAccounts));
      if(!batch.length)break;
      const perAccount=Math.max(12,Math.ceil((limit-all.length)/Math.max(1,batch.length))+8);
      const scanned=await mapWithConcurrency(batch,2,async account=>{ const rows=await collectProfilePostsWithContext(context,account.username,{limit:perAccount}); if(rows&&rows.__threadsChallenge) challengeCount++; return (rows||[]).filter(x=>!isUsedPost(x.url)); });
      scannedAccounts+=batch.length;
      const pools=scanned.filter(Array.isArray).filter(x=>x.length); successfulPools+=pools.length;
      let round=0;
      while(all.length<limit&&pools.some(p=>p.length>round)){ for(const pool of shuffle(pools)){ if(all.length>=limit)break; const item=pool[round]; if(!item||seen.has(item.url))continue; seen.add(item.url); all.push(item); } round++; }
      console.log(`[Threads benchmark batch] scanned=${scannedAccounts}/${maxAccounts} pools=${successfulPools} collected=${all.length}/${limit} challenged=${challengeCount}`);
      if(!all.length && challengeCount>=Math.max(4,Math.ceil(scannedAccounts*0.5))){ console.error(`[Threads][CIRCUIT OPEN] challenged=${challengeCount}/${scannedAccounts} · profile scan stopped to protect collector session`); break; }
    }
    console.log(`[Threads benchmark] accounts=${scannedAccounts} pools=${successfulPools} collected=${all.length} requested=${limit}`);
    return all.slice(0,limit);
  } finally {
    if(context)try{await context.close();}catch{}
    if(browser)try{await browser.close();}catch{}
  }
}

async function runThreadsAccessDiag() {
  let browser, context;
  const cases = [
    ['FAIL_CASE', 'https://www.threads.com/@a_rzen2/post/DcIPOtYAaqJ'],
    ['SUCCESS_CASE', 'https://www.threads.com/@chi_chi1200/post/DcL0JJoG6U7/media']
  ];
  try {
    ({ browser, context } = await openBrowser());
    for (const [label, url] of cases) {
      const page = await context.newPage();
      try {
        page.setDefaultTimeout(16000);
        const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:16000 });
        await page.waitForTimeout(4000);
        const data = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          body: document.body?.innerText?.slice(0,500) || '',
          htmlLength: document.documentElement?.outerHTML?.length || 0,
          postLinks: document.querySelectorAll('a[href*="/post/"]').length,
          images: document.images.length,
          videos: document.querySelectorAll('video').length,
          readyState: document.readyState
        }));
        console.log(`[THREADS ACCESS DIAG][${label}] ${JSON.stringify({ status: response?.status?.() ?? null, ...data })}`);
      } catch (err) {
        console.log(`[THREADS ACCESS DIAG][${label}] ${JSON.stringify({ error: String(err?.message || err), url })}`);
      } finally {
        try { await page.close(); } catch {}
      }
    }
  } catch (err) {
    console.log(`[THREADS ACCESS DIAG][BOOT_ERROR] ${JSON.stringify({ error: String(err?.message || err) })}`);
  } finally {
    if(context)try{await context.close();}catch{}
    if(browser)try{await browser.close();}catch{}
  }
}

// Diagnostics are opt-in: startup must not launch an untracked browser.
if (process.env.THREADS_STARTUP_DIAGNOSTICS === '1' && process.env.ME2_BROWSER_WORKER !== '1') {
  setImmediate(() => { runThreadsAccessDiag().catch(() => {}); });
}

const collectPostDetailsForWorker = withTextFallback(withVideoExtraction(collectPostDetailsRaw));
module.exports={listBenchmarkAccounts,addBenchmarkAccount,addBenchmarkAccountsBulk,deleteBenchmarkAccount,markUsedPost,collectBenchmarkMaterials,collectPostDetails:collectPostDetailsForWorker,collectProfilePosts};
console.log('[Threads][VIDEO PATCH] 게시물 429 시 /media 1회 fallback + 게시물별 실패 격리 + 영상 직접 추출 활성화');
if (process.env.ME2_BROWSER_WORKER !== '1') {
  const { isolatedBrowserTask } = require('./isolatedTask');
  for (const method of ['collectBenchmarkMaterials','collectPostDetails','collectProfilePosts']) {
    module.exports[method] = (...args) => isolatedBrowserTask('benchmarkAccounts', method, args);
  }
  // Main process: 429-cache/cooldown guard wraps a second video-extraction retry around the
  // isolated dispatch (which itself invokes the full worker-side chain above) - see the note
  // above collectPostDetailsRaw for why the video-extraction layer legitimately runs twice.
  module.exports.collectPostDetails = with429Guard(withVideoExtraction(module.exports.collectPostDetails));
  console.log('[Threads][429 GUARD] 상세 20분 캐시 + 429 발생 시 게시물별 15분 cooldown 활성화');
} else {
  console.log('[Threads][TEXT FALLBACK PATCH] 원문 상세 추출 실패 시 프로필/브라우저 fallback 활성화');
}
