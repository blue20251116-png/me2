const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){try{const u=new URL(String(value||''));return `${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}}
function isThreadsMediaUrl(url){const s=String(url||'').trim();if(!/^https?:\/\//i.test(s))return false;try{const h=new URL(s).hostname.toLowerCase();return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');}catch{return false;}}
function isProfileImage(url){return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(String(url||''));}
function isUsableImage(url){return isThreadsMediaUrl(url)&&!isProfileImage(url);}
function uniq(a){return [...new Set((a||[]).filter(Boolean))];}

async function recoverExactPostMedia(sourceUrl,username){
 const playwright=require('playwright');let browser,context,page;
 try{
  browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  context=await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
  page=await context.newPage();page.setDefaultTimeout(18000);
  await page.goto(canonicalUrl(sourceUrl),{waitUntil:'domcontentloaded',timeout:18000});await page.waitForTimeout(2200);
  for(let i=0;i<3;i++){await page.mouse.wheel(0,500);await page.waitForTimeout(350);}
  const found=await page.evaluate(({sourceUrl})=>{
   const canonical=href=>{try{const u=new URL(href,location.origin);return `${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'');}};
   const target=canonical(sourceUrl),postLinks=node=>[...new Set([...node.querySelectorAll('a[href*="/post/"]')].map(a=>canonical(a.href)).filter(Boolean))],mediaCount=node=>node.querySelectorAll('img,video,picture source,video source').length,candidates=[];
   for(const a of document.querySelectorAll('a[href*="/post/"]')){if(canonical(a.href)!==target)continue;let n=a.closest('article,[role="article"]')||a.parentElement;for(let depth=0;depth<12&&n;depth++,n=n.parentElement){const links=postLinks(n);if(links.length===1&&links[0]===target)candidates.push({node:n,media:mediaCount(n),depth});else if(links.length>1&&candidates.length)break;}}
   candidates.sort((a,b)=>b.media-a.media||b.depth-a.depth);const root=candidates[0]?.node||document.querySelector('article,[role="article"]')||document,images=[],videos=[];
   const add=(arr,v)=>{v=String(v||'').trim();if(/^https?:\/\//i.test(v)&&!arr.includes(v))arr.push(v);},addSrcset=(arr,s)=>{for(const part of String(s||'').split(','))add(arr,part.trim().split(/\s+/)[0]);};
   for(const img of root.querySelectorAll('img')){add(images,img.currentSrc);add(images,img.src);addSrcset(images,img.srcset);addSrcset(images,img.getAttribute('srcset'));}
   for(const s of root.querySelectorAll('picture source')){add(images,s.src);addSrcset(images,s.srcset);addSrcset(images,s.getAttribute('srcset'));}
   for(const v of root.querySelectorAll('video')){add(videos,v.currentSrc);add(videos,v.src);for(const s of v.querySelectorAll('source'))add(videos,s.src);}for(const s of root.querySelectorAll('video source'))add(videos,s.src);
   return{images,videos,hasVideo:root.querySelectorAll('video,video source').length>0,candidateCount:candidates.length};
  },{sourceUrl:canonicalUrl(sourceUrl)});
  console.log(`[Threads][EXACT MEDIA RECOVERY] @${username||'-'} source=${canonicalUrl(sourceUrl)} candidates=${found.candidateCount||0} rawImages=${found.images.length} rawVideos=${found.videos.length} hasVideo=${found.hasVideo?'yes':'no'}`);return found;
 }catch(err){console.log(`[Threads][EXACT MEDIA RECOVERY] @${username||'-'} 실패: ${err.message}`);return{images:[],videos:[],hasVideo:false};}
 finally{if(page)try{await page.close();}catch{}if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}
}

benchmark.collectPostDetails=async function restoredCollectPostDetails(url,username){
 const details=await previousCollectPostDetails(url,username);let rawImages=Array.isArray(details?.images)?details.images.filter(Boolean):[],rawVideos=Array.isArray(details?.videos)?details.videos.filter(Boolean):[],images=uniq(rawImages.filter(isUsableImage)).slice(0,10),videos=uniq(rawVideos.filter(isThreadsMediaUrl)).slice(0,5),hasVideo=videos.length>0||!!details?.hasVideo;
 if(!images.length&&!videos.length){const recovered=await recoverExactPostMedia(url,username);rawImages=uniq([...rawImages,...(recovered.images||[])]);rawVideos=uniq([...rawVideos,...(recovered.videos||[])]);images=uniq(rawImages.filter(isUsableImage)).slice(0,10);videos=uniq(rawVideos.filter(isThreadsMediaUrl)).slice(0,5);hasVideo=videos.length>0||hasVideo||!!recovered.hasVideo;}
 const rejectedProfiles=rawImages.filter(isProfileImage).length;if(rejectedProfiles)console.log(`[Threads][MEDIA PROFILE BLOCK] @${username||'-'} rejected=${rejectedProfiles}`);if(!images.length&&!videos.length&&!hasVideo)throw new Error('선택한 Threads 원본 게시물의 사진/영상을 확보하지 못했습니다');
 console.log(`[Threads][RESTORED MEDIA V2] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} exactPostRecovery=yes profileBlocked=yes importerFallback=enabled externalFallback=disabled`);return{...details,images,videos,hasVideo,exactUrl:true};
};

const autopilot=require('./autopilotMaterialEngine');const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function restoredThreadsFirstAutopilot(accountId,options){const result=await previousBuild(accountId,options),images=uniq((Array.isArray(result?.sourceImages)?result.sourceImages:[]).filter(isUsableImage)).slice(0,10),videos=uniq((Array.isArray(result?.sourceVideos)?result.sourceVideos:[]).filter(isThreadsMediaUrl)).slice(0,5),hasVideo=videos.length>0||!!result?.sourceHasVideo||!!result?.hasVideo;if(!result?.sourceUrl||(!images.length&&!videos.length&&!hasVideo))throw new Error('Threads 원본 게시물의 사진/영상을 확보하지 못해 발행하지 않습니다');result.sourceImages=images;result.sourceVideos=videos;if(hasVideo){result.sourceHasVideo=true;result.hasVideo=true;}if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};console.log(`[Autopilot][RESTORED THREADS MEDIA V2] source=${canonicalUrl(result.sourceUrl)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} importerFallback=enabled profileBlocked=yes externalFallback=disabled`);return result;};
console.log('[Threads][MEDIA RESTORE PATCH V2] 동일-post DOM 확장 + src/srcset/picture/video source 복구 · 프로필사진 차단 · 외부미디어 금지');
