const benchmark = require('./benchmarkAccounts');
const previousCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);

function canonicalUrl(value){
  try{const u=new URL(String(value||''));return `${u.origin}${u.pathname}`.replace(/\/media$/i,'');}
  catch{return String(value||'').split(/[?#]/)[0].replace(/\/media$/i,'');}
}
function isThreadsMediaUrl(url){
  const s=String(url||'').trim();
  if(!/^https?:\/\//i.test(s))return false;
  try{
    const h=new URL(s).hostname.toLowerCase();
    return h.includes('cdninstagram.com')||h.includes('fbcdn.net')||h.includes('threads.com')||h.includes('threads.net');
  }catch{return false;}
}
function isProfileImage(url){
  const s=String(url||'');
  return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(s);
}
function isUsableImage(url){return isThreadsMediaUrl(url)&&!isProfileImage(url);}

// 복구 정책:
// benchmarkAccounts가 '정확히 같은 Threads post'에서 확보한 사진/영상 결과를 그대로 사용한다.
// 여기서 상세 DOM을 다시 열어 재검증하지 않는다. 영상 URL이 아직 없어도 hasVideo 신호를 보존해
// 기존 threadsVideoPatch / threadsMediaImporter가 실제 mp4를 가져올 기회를 막지 않는다.
benchmark.collectPostDetails=async function restoredCollectPostDetails(url,username){
  const details=await previousCollectPostDetails(url,username);
  const rawImages=Array.isArray(details?.images)?details.images.filter(Boolean):[];
  const images=[...new Set(rawImages.filter(isUsableImage))].slice(0,10);
  const videos=[...new Set((Array.isArray(details?.videos)?details.videos:[]).filter(isThreadsMediaUrl))].slice(0,5);
  const rejectedProfiles=rawImages.filter(isProfileImage).length;
  const hasVideo=videos.length>0||!!details?.hasVideo;

  if(rejectedProfiles){
    console.log(`[Threads][MEDIA PROFILE BLOCK] @${username||'-'} rejected=${rejectedProfiles}`);
  }
  if(!images.length&&!videos.length&&!hasVideo){
    throw new Error('선택한 Threads 원본 게시물의 사진/영상을 확보하지 못했습니다');
  }

  console.log(`[Threads][RESTORED MEDIA] @${username||'-'} source=${canonicalUrl(url)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} samePostOnly=yes profileBlocked=yes importerFallback=enabled externalFallback=disabled`);
  return {...details,images,videos,hasVideo,exactUrl:true};
};

const autopilot=require('./autopilotMaterialEngine');
const previousBuild=autopilot.buildThreadsFirstAutopilot.bind(autopilot);
autopilot.buildThreadsFirstAutopilot=async function restoredThreadsFirstAutopilot(accountId,options){
  const result=await previousBuild(accountId,options);
  const images=[...new Set((Array.isArray(result?.sourceImages)?result.sourceImages:[]).filter(isUsableImage))].slice(0,10);
  const videos=[...new Set((Array.isArray(result?.sourceVideos)?result.sourceVideos:[]).filter(isThreadsMediaUrl))].slice(0,5);
  const hasVideo=videos.length>0||!!result?.sourceHasVideo||!!result?.hasVideo;

  // 영상 존재 신호가 있으면 videos=0이어도 통과시킨다.
  // 뒤의 기존 VIDEO IMPORTER가 sourceUrl에서 실제 영상을 가져오도록 한다.
  if(!result?.sourceUrl||(!images.length&&!videos.length&&!hasVideo)){
    throw new Error('Threads 원본 게시물의 사진/영상을 확보하지 못해 발행하지 않습니다');
  }

  result.sourceImages=images;
  result.sourceVideos=videos;
  if(hasVideo){
    result.sourceHasVideo=true;
    result.hasVideo=true;
  }
  if(result.product&&typeof result.product==='object')result.product={...result.product,image:''};

  console.log(`[Autopilot][RESTORED THREADS MEDIA] source=${canonicalUrl(result.sourceUrl)} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} importerFallback=enabled profileBlocked=yes externalFallback=disabled`);
  return result;
};

console.log('[Threads][MEDIA RESTORE PATCH] 예전 동일-post 사진/영상 수집 흐름 복구 · 영상 importer 우선 · 프로필사진만 차단 · 외부미디어 금지');
