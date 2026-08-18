const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){try{const u=new URL(String(value||''));return `${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}}
function isThreadsMediaUrl(url){const s=String(url||'').trim();if(!/^https?:\/\//i.test(s))return false;try{const h=new URL(s).hostname.toLowerCase();return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');}catch{return false;}}
function isProfileImage(url){return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(String(url||''));}
function uniq(a){return [...new Set((a||[]).filter(Boolean))];}
function addSrcset(out,s){for(const p of String(s||'').split(',')){const u=p.trim().split(/\s+/)[0];if(/^https?:\/\//i.test(u))out.push(u);}}

async function browserImportPostMedia(postUrl){
 const playwright=require('playwright'); let browser;
 try{
  browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const context=await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
  const page=await context.newPage(); page.setDefaultTimeout(18000);
  const netImages=[],netVideos=[];
  page.on('response',async r=>{try{const u=r.url(),h=await r.allHeaders().catch(()=>({})),ct=String(h['content-type']||'').toLowerCase();if(ct.startsWith('image/')&&isThreadsMediaUrl(u))netImages.push(u);if((ct.startsWith('video/')||/\.mp4(?:[?#]|$)/i.test(u))&&isThreadsMediaUrl(u))netVideos.push(u);}catch{}});
  await page.goto(canonicalUrl(postUrl),{waitUntil:'domcontentloaded',timeout:18000}); await page.waitForTimeout(2500);
  // 캐러셀 lazy-load 유도. 링크 이동은 하지 않고 현재 post 내부 버튼만 순차 클릭한다.
  for(let i=0;i<8;i++){try{const clicked=await page.evaluate(()=>{const buttons=[...document.querySelectorAll('button,[role="button"]')];const b=buttons.find(x=>/다음|next/i.test(String(x.getAttribute('aria-label')||x.textContent||'')));if(b){b.click();return true;}return false;});if(!clicked)break;await page.waitForTimeout(350);}catch{break;}}
  const dom=await page.evaluate(()=>{const images=[],videos=[];const add=(a,v)=>{v=String(v||'').trim();if(/^https?:\/\//i.test(v))a.push(v);};const srcset=(a,s)=>{for(const p of String(s||'').split(','))add(a,p.trim().split(/\s+/)[0]);};for(const img of document.querySelectorAll('img')){const r=img.getBoundingClientRect();if(r.width<180||r.height<180)continue;add(images,img.currentSrc);add(images,img.src);srcset(images,img.srcset);srcset(images,img.getAttribute('srcset'));}for(const s of document.querySelectorAll('picture source')){add(images,s.src);srcset(images,s.srcset);srcset(images,s.getAttribute('srcset'));}for(const v of document.querySelectorAll('video')){add(videos,v.currentSrc);add(videos,v.src);add(images,v.poster);for(const s of v.querySelectorAll('source'))add(videos,s.src);}return{images,videos};});
  await context.close();
  const images=uniq([...(dom.images||[]),...netImages]).filter(x=>isThreadsMediaUrl(x)&&!isProfileImage(x)).slice(0,10);
  const videos=uniq([...(dom.videos||[]),...netVideos]).filter(isThreadsMediaUrl).slice(0,5);
  return{images,videos,hasVideo:videos.length>0};
 }catch(e){console.warn(`[Threads][BROWSER MEDIA IMPORT] 실패 source=${canonicalUrl(postUrl)} reason="${e.message}"`);return{images:[],videos:[],hasVideo:false};}
 finally{if(browser)try{await browser.close();}catch{}}
}

benchmark.collectPostDetails=async function restoredCollectPostDetails(url,username){
 const details=await previousCollectPostDetails(url,username);
 let images=uniq((details?.images||[]).filter(x=>isThreadsMediaUrl(x)&&!isProfileImage(x))).slice(0,10);
 let videos=uniq((details?.videos||[]).filter(isThreadsMediaUrl)).slice(0,5);
 let imported=false;
 // 기존 수집기가 0건을 반환할 때만, 예전에 성공했던 browser importer 방식으로 실제 post URL을 다시 연다.
 if(!images.length&&!videos.length){
   const recovered=await browserImportPostMedia(url); imported=true;
   images=recovered.images; videos=recovered.videos;
   console.log(`[Threads][BROWSER MEDIA IMPORT] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} bundleItems=${images.length+videos.length}`);
 }
 const hasVideo=videos.length>0||!!details?.hasVideo;
 console.log(`[Threads][MEDIA RESTORE V4] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} browserFallback=${imported?'used':'not-needed'} profileBlocked=yes`);
 return{...details,images,videos,hasVideo};
};

const autopilot=require('./autopilotMaterialEngine');
const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function restoredThreadsFirstAutopilot(accountId,options){
 const result=await previousBuild(accountId,options);
 if(Array.isArray(result?.sourceImages))result.sourceImages=uniq(result.sourceImages.filter(x=>isThreadsMediaUrl(x)&&!isProfileImage(x))).slice(0,10);
 if(Array.isArray(result?.sourceVideos))result.sourceVideos=uniq(result.sourceVideos.filter(isThreadsMediaUrl)).slice(0,5);
 const hasVideo=(result?.sourceVideos?.length||0)>0||!!result?.sourceHasVideo||!!result?.hasVideo;
 if(hasVideo){result.sourceHasVideo=true;result.hasVideo=true;}
 if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};
 console.log(`[Autopilot][RESTORED THREADS MEDIA V4] source=${canonicalUrl(result?.sourceUrl)} images=${result?.sourceImages?.length||0} videos=${result?.sourceVideos?.length||0} hasVideo=${hasVideo?'yes':'no'} browserImporter=enabled`);
 return result;
};
console.log('[Threads][MEDIA RESTORE PATCH V4] 기존 수집 우선 + 0건일 때 실제 post browser importer + 캐러셀 lazy-load + 프로필사진 차단');
