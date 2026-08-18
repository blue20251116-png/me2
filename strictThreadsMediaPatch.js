const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){try{const u=new URL(String(value||''));return `${u.origin}${u.pathname}`.replace(/\/media$/i,'');}catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}}
function isThreadsMediaUrl(url){const s=String(url||'').trim();if(!/^https?:\/\//i.test(s))return false;try{const h=new URL(s).hostname.toLowerCase();return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');}catch{return false;}}
function isProfileImage(url){return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(String(url||''));}
function uniq(a){return [...new Set((a||[]).filter(Boolean))];}

// 초기 정상 동작 방식으로 복원:
// benchmarkAccounts/threadsVideoPatch가 확보한 동일-post 미디어를 그대로 신뢰하고,
// 여기서 DOM을 다시 열어 EXACT MEDIA RECOVERY로 재검증/탈락시키지 않는다.
// 프로필 사진만 제거하며 영상 신호는 importer가 후속 처리할 수 있도록 유지한다.
benchmark.collectPostDetails=async function restoredCollectPostDetails(url,username){
 const details=await previousCollectPostDetails(url,username);
 const rawImages=Array.isArray(details?.images)?details.images.filter(Boolean):[];
 const rawVideos=Array.isArray(details?.videos)?details.videos.filter(Boolean):[];
 const images=uniq(rawImages.filter(x=>isThreadsMediaUrl(x)&&!isProfileImage(x))).slice(0,10);
 const videos=uniq(rawVideos.filter(isThreadsMediaUrl)).slice(0,5);
 const hasVideo=videos.length>0||!!details?.hasVideo;
 const rejectedProfiles=rawImages.filter(isProfileImage).length;
 if(rejectedProfiles)console.log(`[Threads][MEDIA PROFILE BLOCK] @${username||'-'} rejected=${rejectedProfiles}`);
 console.log(`[Threads][MEDIA RESTORE V3] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} exactRecovery=disabled importerFallback=enabled profileBlocked=yes`);
 return{...details,images,videos,hasVideo};
};

const autopilot=require('./autopilotMaterialEngine');
const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function restoredThreadsFirstAutopilot(accountId,options){
 const result=await previousBuild(accountId,options);
 // build 단계가 이미 VIDEO IMPORT 성공으로 만든 sourceImages/sourceVideos/bundle을 다시 엄격 검증하지 않는다.
 // 이 패치의 역할은 외부 미디어 차단과 프로필 사진 제거뿐이다.
 if(Array.isArray(result?.sourceImages))result.sourceImages=uniq(result.sourceImages.filter(x=>isThreadsMediaUrl(x)&&!isProfileImage(x))).slice(0,10);
 if(Array.isArray(result?.sourceVideos))result.sourceVideos=uniq(result.sourceVideos.filter(isThreadsMediaUrl)).slice(0,5);
 const hasVideo=(result?.sourceVideos?.length||0)>0||!!result?.sourceHasVideo||!!result?.hasVideo;
 if(hasVideo){result.sourceHasVideo=true;result.hasVideo=true;}
 if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};
 console.log(`[Autopilot][RESTORED THREADS MEDIA V3] source=${canonicalUrl(result?.sourceUrl)} images=${result?.sourceImages?.length||0} videos=${result?.sourceVideos?.length||0} hasVideo=${hasVideo?'yes':'no'} importerFallback=enabled strictReject=disabled`);
 return result;
};

console.log('[Threads][MEDIA RESTORE PATCH V3] 초기 미디어 흐름 복원 · EXACT MEDIA RECOVERY 제거 · importer 우선 · 프로필사진만 차단');
