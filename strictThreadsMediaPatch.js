const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){try{const u=new URL(String(value||''));return`${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}}
function isThreadsMediaUrl(url){const s=String(url||'').trim();if(!/^https?:\/\//i.test(s))return false;try{const h=new URL(s).hostname.toLowerCase();return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');}catch{return false;}}
function isProfileImage(url){const s=String(url||'');return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150)/i.test(s);}
function isPostImage(url){return isThreadsMediaUrl(url)&&!isProfileImage(url);}
const isThreadsCdnImage=isPostImage;

let strictQueue=Promise.resolve();
function serialized(task){const run=strictQueue.then(task,task);strictQueue=run.catch(()=>{});return run;}

async function scrapeStrictPostMedia(postUrl){
 return serialized(async()=>{
  const playwright=require('playwright');let browser,context;
  try{
   browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--disable-renderer-backgrounding']});
   context=await browser.newContext({locale:'ko-KR',viewport:{width:1000,height:1300},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
   const page=await context.newPage();page.setDefaultTimeout(15000);const networkVideos=[];
   page.on('response',r=>{try{const u=r.url(),ct=String(r.headers()['content-type']||'');if((/video|mp4/i.test(ct)||/\.mp4(?:\?|$)/i.test(u))&&isThreadsMediaUrl(u)&&!networkVideos.includes(u))networkVideos.push(u);}catch{}});
   await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:15000});await page.waitForTimeout(1800);
   try{await page.evaluate(()=>{for(const v of document.querySelectorAll('video')){try{v.muted=true;v.play().catch(()=>{});}catch{}}});}catch{}
   await page.mouse.wheel(0,500);await page.waitForTimeout(700);
   const result=await page.evaluate(({sourceUrl})=>{const clean=s=>String(s||'').replace(/\s+/g,' ').trim();const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'');}};const badImage=s=>/(?:t51\.82787-19|profile[_-]?pic|avatar|s150x150|150x150)/i.test(String(s||''));const target=canonical(sourceUrl),roots=[];for(const a of document.querySelectorAll('a[href*="/post/"]')){if(canonical(a.href||'')!==target)continue;const article=a.closest('article,[role="article"]');if(article)roots.push(article);let n=a.parentElement;for(let i=0;i<10&&n;i++,n=n.parentElement){const links=[...new Set([...n.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];if(links.length===1&&links[0]===target&&clean(n.innerText).length<=6500)roots.push(n);if(links.length>1)break;}}const root=roots.sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height)[0]||null,images=[],videos=[];let hasVideo=false;const add=(arr,v)=>{const s=String(v||'').trim();if(/^https?:\/\//i.test(s)&&!arr.includes(s))arr.push(s);};if(root){for(const v of root.querySelectorAll('video')){hasVideo=true;add(videos,v.currentSrc);add(videos,v.src);for(const s of v.querySelectorAll('source[src]'))add(videos,s.src||s.getAttribute('src'));}for(const img of root.querySelectorAll('img')){const src=img.currentSrc||img.src||'',alt=String(img.alt||'').toLowerCase(),r=img.getBoundingClientRect();if(!src||badImage(src)||r.width<150||r.height<150||/profile|프로필|avatar|사용자/.test(alt)||img.closest('video'))continue;add(images,src);}}const ogImage=document.querySelector('meta[property="og:image"]')?.content||'',ogVideo=document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')?.content||'';if(!images.length&&!badImage(ogImage))add(images,ogImage);if(!videos.length&&ogVideo){add(videos,ogVideo);hasVideo=true;}return{foundRoot:!!root,images:images.slice(0,10),videos:videos.slice(0,5),hasVideo};},{sourceUrl:postUrl});
   result.videos=[...new Set([...(result.videos||[]),...networkVideos])].slice(0,5);if(result.videos.length)result.hasVideo=true;return result;
  }finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}
 });
}

benchmark.collectPostDetails=async function strictCollectPostDetails(url,username){
 const details=await previousCollectPostDetails(url,username);let strict={foundRoot:false,images:[],videos:[],hasVideo:false};
 try{strict=await scrapeStrictPostMedia(url);}catch(e){console.log(`[Threads][STRICT MEDIA] 상세 재스크랩 실패 @${username||'-'}: ${e.message}`);}
 const rawFallback=Array.isArray(details?.images)?details.images:[],rawStrict=Array.isArray(strict.images)?strict.images:[];
 const rejectedProfiles=[...rawStrict,...rawFallback].filter(isProfileImage);
 if(rejectedProfiles.length)console.log(`[Threads][MEDIA PROFILE BLOCK] @${username||'-'} rejected=${rejectedProfiles.length}`);
 const fallbackImages=rawFallback.filter(isPostImage),fallbackVideos=(Array.isArray(details?.videos)?details.videos:[]).filter(isThreadsMediaUrl),strictImages=rawStrict.filter(isPostImage),strictVideos=(strict.videos||[]).filter(isThreadsMediaUrl);
 const images=[...new Set([...strictImages,...fallbackImages])].slice(0,10),videos=[...new Set([...strictVideos,...fallbackVideos])].slice(0,5),hasVideo=videos.length>0||!!strict.hasVideo||!!details?.hasVideo;
 if(!images.length&&!videos.length)throw new Error('Threads 원본 게시물 미디어를 확보하지 못했습니다 (프로필 사진은 제외)');
 const mode=strictImages.length||strictVideos.length?'detail':'same-post-fallback';
 console.log(`[Threads][STRICT MEDIA] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} mode=${mode} externalFallback=disabled`);
 return{...details,images,videos,hasVideo,exactUrl:true};
};

const autopilot=require('./autopilotMaterialEngine');const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function strictThreadsFirstAutopilot(accountId,options){const result=await previousBuild(accountId,options);const images=(Array.isArray(result?.sourceImages)?result.sourceImages:[]).filter(isPostImage),videos=(Array.isArray(result?.sourceVideos)?result.sourceVideos:[]).filter(isThreadsMediaUrl);if(!result?.sourceUrl||(!images.length&&!videos.length))throw new Error('Threads 원본 미디어가 없는 소재는 자동발행하지 않습니다');result.sourceImages=images;result.sourceVideos=videos;if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};console.log(`[Autopilot][STRICT THREADS MEDIA] source=${canonicalUrl(result.sourceUrl)} images=${images.length} videos=${videos.length} externalFallback=disabled`);return result;};
console.log('[Threads][STRICT MEDIA PATCH V2] 동일 post 미디어만 + 프로필/avatar/150x150 완전차단 + 외부 fallback 차단');
