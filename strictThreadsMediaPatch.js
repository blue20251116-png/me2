const benchmark = require('./benchmarkAccounts');

const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return `${u.origin}${u.pathname}`.replace(/\/media$/i, '');
  } catch {
    return String(value || '').split(/[?#]/)[0].replace(/\/media$/i, '');
  }
}

function isThreadsCdnImage(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.includes('cdninstagram.com') || host.includes('fbcdn.net') || host.includes('threads.com') || host.includes('threads.net');
  } catch { return false; }
}

function isThreadsMediaUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.includes('cdninstagram.com') || host.includes('fbcdn.net') || host.includes('threads.com') || host.includes('threads.net');
  } catch { return false; }
}

async function scrapeStrictPostMedia(postUrl) {
  const playwright = require('playwright');
  let browser, context;
  try {
    browser = await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    context = await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    const networkVideos=[];
    page.on('response', r=>{try{const u=r.url();const ct=String(r.headers()['content-type']||'');if((/video|mp4/i.test(ct)||/\.mp4(?:\?|$)/i.test(u))&&isThreadsMediaUrl(u)&&!networkVideos.includes(u))networkVideos.push(u);}catch{}});
    await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:18000});
    await page.waitForTimeout(2500);

    const result=await page.evaluate(({sourceUrl})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'');}};
      const target=canonical(sourceUrl);
      const roots=[];
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        if(canonical(a.href||'')!==target)continue;
        const article=a.closest('article,[role="article"]');if(article)roots.push(article);
        let n=a.parentElement;for(let i=0;i<10&&n;i++,n=n.parentElement){const links=[...new Set([...n.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];if(links.length===1&&links[0]===target&&clean(n.innerText).length<=6500)roots.push(n);if(links.length>1)break;}
      }
      const root=roots.sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height)[0]||null;
      const images=[],videos=[];let hasVideo=false;
      const add=(arr,v)=>{const s=String(v||'').trim();if(/^https?:\/\//i.test(s)&&!arr.includes(s))arr.push(s);};
      if(root){
        for(const v of root.querySelectorAll('video')){hasVideo=true;add(videos,v.currentSrc);add(videos,v.src);for(const s of v.querySelectorAll('source[src]'))add(videos,s.src||s.getAttribute('src'));}
        for(const img of root.querySelectorAll('img')){const src=img.currentSrc||img.src||'';const alt=String(img.alt||'').toLowerCase();const r=img.getBoundingClientRect();if(!src||r.width<150||r.height<150||/profile|프로필|avatar|사용자/.test(alt)||img.closest('video'))continue;add(images,src);}
      }
      // 상세 root가 안 잡혀도 해당 post 페이지 자체의 OG 미디어는 같은 게시물의 원본 메타데이터다.
      const ogImage=document.querySelector('meta[property="og:image"]')?.content||'';
      const ogVideo=document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')?.content||'';
      if(!images.length)add(images,ogImage);
      if(!videos.length&&ogVideo){add(videos,ogVideo);hasVideo=true;}
      return{foundRoot:!!root,images:images.slice(0,10),videos:videos.slice(0,5),hasVideo};
    },{sourceUrl:postUrl});
    result.videos=[...new Set([...(result.videos||[]),...networkVideos])].slice(0,5);
    if(result.videos.length)result.hasVideo=true;
    return result;
  } finally {if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}
}

benchmark.collectPostDetails=async function strictCollectPostDetails(url,username){
  const details=await previousCollectPostDetails(url,username);
  let strict={foundRoot:false,images:[],videos:[],hasVideo:false};
  try{strict=await scrapeStrictPostMedia(url);}catch(e){console.log(`[Threads][STRICT MEDIA] 상세 재스크랩 실패 @${username||'-'}: ${e.message}`);}

  // benchmarkAccounts fallback도 정확히 같은 post URL에서만 수집되므로 원본으로 인정한다.
  const fallbackImages=(Array.isArray(details?.images)?details.images:[]).filter(isThreadsCdnImage);
  const fallbackVideos=(Array.isArray(details?.videos)?details.videos:[]).filter(isThreadsMediaUrl);
  const strictImages=(strict.images||[]).filter(isThreadsCdnImage);
  const strictVideos=(strict.videos||[]).filter(isThreadsMediaUrl);
  const images=[...new Set([...strictImages,...fallbackImages])].slice(0,10);
  const videos=[...new Set([...strictVideos,...fallbackVideos])].slice(0,5);

  if(!images.length&&!videos.length)throw new Error('Threads 원본 게시물에서 사진/영상을 스크래핑하지 못했습니다');
  const mode=strictImages.length||strictVideos.length?'detail':'same-post-profile-fallback';
  console.log(`[Threads][STRICT MEDIA] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} mode=${mode} externalFallback=disabled`);
  return{...details,images,videos,hasVideo:videos.length>0,exactUrl:true};
};

// 완전자동화는 선택된 Threads 게시물에서 스크래핑한 미디어가 없으면 반드시 다음 소재로 넘긴다.
// Pexels/AI/쿠팡 상품 이미지/다른 게시물 이미지는 절대 fallback으로 사용하지 않는다.
const autopilot=require('./autopilotMaterialEngine');
const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function strictThreadsFirstAutopilot(accountId,options){
  const result=await previousBuild(accountId,options);
  const images=(Array.isArray(result?.sourceImages)?result.sourceImages:[]).filter(isThreadsCdnImage);
  const videos=(Array.isArray(result?.sourceVideos)?result.sourceVideos:[]).filter(isThreadsMediaUrl);
  if(!result?.sourceUrl||(!images.length&&!videos.length))throw new Error('Threads 원본 미디어가 없는 소재는 자동발행하지 않습니다');
  result.sourceImages=images;
  result.sourceVideos=videos;
  if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};
  console.log(`[Autopilot][STRICT THREADS MEDIA] source=${canonicalUrl(result.sourceUrl)} images=${images.length} videos=${videos.length} externalFallback=disabled`);
  return result;
};

console.log('[Threads][STRICT MEDIA PATCH] 선택한 Threads 동일 게시물 사진/영상만 스크래핑 · OG/동일-post 프로필 fallback · Pexels/AI/쿠팡/타게시물 미디어 차단');
