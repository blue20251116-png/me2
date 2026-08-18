const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){try{const u=new URL(String(value||''));return`${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}}
function isThreadsMediaUrl(url){const s=String(url||'').trim();if(!/^https?:\/\//i.test(s))return false;try{const h=new URL(s).hostname.toLowerCase();return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');}catch{return false;}}
function isProfileImage(url){const s=String(url||'');return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(s);}
function isPostImage(url){return isThreadsMediaUrl(url)&&!isProfileImage(url);}

let strictQueue=Promise.resolve();
function serialized(task){const run=strictQueue.then(task,task);strictQueue=run.catch(()=>{});return run;}

async function scrapeStrictPostMedia(postUrl){
 return serialized(async()=>{
  const playwright=require('playwright');let browser,context;
  try{
   browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--disable-renderer-backgrounding']});
   context=await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
   const page=await context.newPage();page.setDefaultTimeout(20000);const networkVideos=[];
   page.on('response',r=>{try{const u=r.url(),ct=String(r.headers()['content-type']||'');if((/video|mp4/i.test(ct)||/\.mp4(?:\?|$)/i.test(u))&&isThreadsMediaUrl(u)&&!networkVideos.includes(u))networkVideos.push(u);}catch{}});
   await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:20000});await page.waitForTimeout(2500);
   try{await page.evaluate(()=>{for(const v of document.querySelectorAll('video')){try{v.muted=true;v.play().catch(()=>{});}catch{}}});}catch{}
   await page.mouse.wheel(0,550);await page.waitForTimeout(900);

   const result=await page.evaluate(({sourceUrl})=>{
    const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
    const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'');}};
    const badImage=s=>/(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|s150x150|150x150|_s150x150_)/i.test(String(s||''));
    const target=canonical(sourceUrl),candidates=[];
    const addCandidate=node=>{if(!node||candidates.includes(node))return;const links=[...new Set([...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];if(!links.includes(target))return;const rect=node.getBoundingClientRect(),txt=clean(node.innerText||'');const imgs=[...node.querySelectorAll('img')].filter(img=>{const src=img.currentSrc||img.src||'';const r=img.getBoundingClientRect();return src&&!badImage(src)&&r.width>=180&&r.height>=180;});const vids=[...node.querySelectorAll('video')];const exactOnly=links.length===1;const score=(exactOnly?10000:0)+(imgs.length*1500)+(vids.length*2500)+Math.min(txt.length,2000)+Math.min(rect.width*rect.height/1000,3000);candidates.push({node,score,exactOnly,mediaCount:imgs.length+vids.length});};

    for(const a of document.querySelectorAll('a[href*="/post/"]')){
      if(canonical(a.href||'')!==target)continue;
      addCandidate(a.closest('article,[role="article"]'));
      let n=a.parentElement;for(let i=0;i<12&&n;i++,n=n.parentElement)addCandidate(n);
    }

    candidates.sort((a,b)=>b.score-a.score);
    const bestWithMedia=candidates.find(x=>x.mediaCount>0&&x.exactOnly)||candidates.find(x=>x.mediaCount>0)||candidates.find(x=>x.exactOnly)||candidates[0]||null;
    const root=bestWithMedia?.node||null;
    const images=[],videos=[];let hasVideo=false;
    const add=(arr,v)=>{const s=String(v||'').trim();if(/^https?:\/\//i.test(s)&&!arr.includes(s))arr.push(s);};
    const addSrcset=(arr,srcset)=>{for(const part of String(srcset||'').split(',')){const u=part.trim().split(/\s+/)[0];if(u&&!badImage(u))add(arr,u);}};

    if(root){
      for(const v of root.querySelectorAll('video')){hasVideo=true;add(videos,v.currentSrc);add(videos,v.src);for(const s of v.querySelectorAll('source[src]'))add(videos,s.src||s.getAttribute('src'));}
      for(const img of root.querySelectorAll('img')){const src=img.currentSrc||img.src||'',alt=String(img.alt||'').toLowerCase(),r=img.getBoundingClientRect();if(!src||badImage(src)||r.width<180||r.height<180||/profile|프로필|avatar|사용자/.test(alt)||img.closest('video'))continue;add(images,src);addSrcset(images,img.srcset);}
      for(const s of root.querySelectorAll('picture source[srcset],source[srcset]'))addSrcset(images,s.getAttribute('srcset'));
      for(const el of root.querySelectorAll('[style*="background-image"]')){const m=String(el.style.backgroundImage||'').match(/url\(["']?([^"')]+)["']?\)/i);if(m&&!badImage(m[1]))add(images,m[1]);}
    }

    // 정확한 post 상세 페이지의 OG 미디어는 root 여부와 무관하게 보조 허용한다. 프로필 URL은 필터에서 제거한다.
    const ogImage=document.querySelector('meta[property="og:image"]')?.content||'';
    const ogVideo=document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')?.content||'';
    if(ogImage&&!badImage(ogImage))add(images,ogImage);
    if(ogVideo){add(videos,ogVideo);hasVideo=true;}

    return{foundRoot:!!root,rootScore:bestWithMedia?.score||0,images:images.slice(0,10),videos:videos.slice(0,5),hasVideo};
   },{sourceUrl:postUrl});

   result.videos=[...new Set([...(result.videos||[]),...networkVideos])].slice(0,5);if(result.videos.length)result.hasVideo=true;return result;
  }finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}
 });
}

benchmark.collectPostDetails=async function strictCollectPostDetails(url,username){
 const details=await previousCollectPostDetails(url,username);let strict={foundRoot:false,rootScore:0,images:[],videos:[],hasVideo:false};
 try{strict=await scrapeStrictPostMedia(url);}catch(e){console.log(`[Threads][STRICT MEDIA] 상세 post 재스크랩 실패 @${username||'-'}: ${e.message}`);}
 const strictImages=(Array.isArray(strict.images)?strict.images:[]).filter(isPostImage);const strictVideos=(Array.isArray(strict.videos)?strict.videos:[]).filter(isThreadsMediaUrl);const rejected=(Array.isArray(strict.images)?strict.images:[]).filter(isProfileImage);
 if(rejected.length)console.log(`[Threads][MEDIA PROFILE BLOCK] @${username||'-'} rejected=${rejected.length}`);
 if(!strictImages.length&&!strictVideos.length)throw new Error('선택한 Threads 원본 게시물의 본문 미디어를 확보하지 못했습니다');
 console.log(`[Threads][STRICT MEDIA] @${username||'-'} source=${canonicalUrl(url)} images=${strictImages.length} videos=${strictVideos.length} root=${strict.foundRoot?'yes':'no'} score=${strict.rootScore||0} mode=exact-post-only profileFallback=disabled externalFallback=disabled`);
 return{...details,images:strictImages,videos:strictVideos,hasVideo:strictVideos.length>0||!!strict.hasVideo,exactUrl:true};
};

const autopilot=require('./autopilotMaterialEngine');const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function strictThreadsFirstAutopilot(accountId,options){const result=await previousBuild(accountId,options);const images=(Array.isArray(result?.sourceImages)?result.sourceImages:[]).filter(isPostImage),videos=(Array.isArray(result?.sourceVideos)?result.sourceVideos:[]).filter(isThreadsMediaUrl);if(!result?.sourceUrl||(!images.length&&!videos.length))throw new Error('Threads 원본 게시물의 본문 사진/영상을 확보하지 못해 발행하지 않습니다');result.sourceImages=images;result.sourceVideos=videos;if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};console.log(`[Autopilot][STRICT THREADS MEDIA] source=${canonicalUrl(result.sourceUrl)} images=${images.length} videos=${videos.length} profileFallback=disabled externalFallback=disabled`);return result;};
console.log('[Threads][STRICT MEDIA PATCH V4] 정확 post root 점수선택 + srcset/OG/video network 추출 · 프로필/타게시물 fallback 금지');
