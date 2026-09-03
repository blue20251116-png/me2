const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const __me2Fs = require('fs');
const __me2Path = require('path');
const { editVideo: __me2EditVideo } = require('./videoEditor');

function resolveThreadsAppCreds(account){
  const shared=getSystemApiSettings();
  return{
    appId:shared.threads_app_id||process.env.THREADS_APP_ID||account?.threads_app_id||null,
    appSecret:shared.threads_app_secret||process.env.THREADS_APP_SECRET||account?.threads_app_secret||null,
    redirectUri:shared.threads_redirect_uri||process.env.THREADS_REDIRECT_URI||account?.threads_redirect_uri||null
  };
}

const GRAPH_BASE='https://graph.threads.net/v1.0';
const MEDIA_BUNDLE_PREFIX='__THREADS_MEDIA_BUNDLE__';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function __me2NormalizeCarouselVideoUrl(rawUrl){
  try{
    const u=new URL(String(rawUrl||''));
    const marker='/uploads/';
    const idx=u.pathname.indexOf(marker);
    if(idx<0)throw new Error('로컬 uploads URL이 아닙니다');
    const relative=decodeURIComponent(u.pathname.slice(idx+marker.length));
    const uploadsRoot=__me2Path.resolve(__dirname,'db','uploads');
    const inputPath=__me2Path.resolve(uploadsRoot,relative);
    if(!inputPath.startsWith(uploadsRoot+__me2Path.sep)&&inputPath!==uploadsRoot)throw new Error('잘못된 uploads 경로입니다');
    if(!__me2Fs.existsSync(inputPath))throw new Error('원본 영상 파일이 영속 저장소에 없습니다');
    const normalized=await __me2EditVideo({inputPath,outputDir:uploadsRoot,start:0,end:null,mute:false});
    const nextUrl=`${u.protocol}//${u.host}/uploads/${encodeURIComponent(normalized.filename)}`;
    console.log(`[Threads][CAROUSEL_VIDEO_NORMALIZE] success old=${rawUrl} new=${nextUrl} size=${normalized.size} duration=${Number(normalized.duration||0).toFixed(2)}s`);
    return nextUrl;
  }catch(err){
    console.error(`[Threads][CAROUSEL_VIDEO_NORMALIZE] failed url=${rawUrl} reason="${err.message}"`);
    return String(rawUrl||'');
  }
}

// Threads 본문은 발행 직전에 한 번 더 정리한다
// 이미 DB에 저장된 예약글/대기글도 이 단계를 지나므로 생성 시점이 오래됐어도 마침표가 제거된다
// 숫자 소수점(1.5)처럼 숫자 사이의 점은 보존한다
function sanitizePublishedThreadsText(value){
  return String(value||'')
    .replace(/(^|[^\d])\.(?=\s|$)/g,'$1')
    .replace(/[ \t]+\n/g,'\n')
    .trim();
}

// Threads는 TEXT 댓글의 첫 URL을 자동으로 링크 카드로 잡는 경우가 있다
// Coupang 댓글에 URL이 하나뿐이면 같은 목적지의 두 번째 URL을 fragment 변형으로 추가해
// "URL 2개" 형태로 발행한다. fragment는 서버 요청에 전달되지 않으므로 목적지는 동일하다
// 이 처리는 댓글에만 적용하며 일반 본문은 건드리지 않는다
function applyCoupangReplyPreviewGuard(value){
  const text=sanitizePublishedThreadsText(value);
  const matches=[...text.matchAll(/https?:\/\/link\.coupang\.com\/[^\s]+/gi)];
  if(matches.length!==1)return{text,guardApplied:false,urlCount:matches.length};

  const original=matches[0][0];
  const alternate=original.includes('#')?`${original}preview2`:`${original}#preview2`;
  return{
    text:`${text}\n${alternate}`.trim(),
    guardApplied:true,
    urlCount:2
  };
}

function logThreadsError(stage,err,extra={}){
  const apiErr=err.response?.data?.error||{},status=err.response?.status||'-';
  console.error(`[Threads][${stage}][ERROR] status=${status} type=${apiErr.type||'-'} code=${apiErr.code||'-'} subcode=${apiErr.error_subcode||'-'} message=${apiErr.message||err.message||'-'} `+Object.entries(extra).map(([k,v])=>`${k}=${v}`).join(' '));
  console.error(`[Threads][${stage}][RAW]`,JSON.stringify(err.response?.data||{}));
}

function getAuthUrl(accountId){
  const account=getAccount(accountId);
  if(!account)throw new Error('존재하지 않는 계정입니다');
  const{appId,redirectUri}=resolveThreadsAppCreds(account);
  if(!appId)throw new Error('Threads App ID가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  if(!redirectUri)throw new Error('Threads Redirect URI가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  const scopes=['threads_basic','threads_content_publish','threads_manage_insights','threads_manage_replies','threads_read_replies'].join(',');
  return`https://threads.net/oauth/authorize?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&response_type=code&state=${encodeURIComponent(accountId)}`;
}

async function exchangeCodeForToken(accountId,code){
  const account=getAccount(accountId);
  if(!account)throw new Error('존재하지 않는 계정입니다');
  const{appId,appSecret,redirectUri}=resolveThreadsAppCreds(account);
  try{
    return(await axios.post('https://graph.threads.net/oauth/access_token',null,{params:{client_id:appId,client_secret:appSecret,grant_type:'authorization_code',redirect_uri:redirectUri,code},timeout:20000})).data;
  }catch(err){logThreadsError('OAUTH_SHORT_TOKEN',err,{accountId});throw err;}
}

async function exchangeForLongLivedToken(accountId,shortLivedToken){
  const account=getAccount(accountId);
  if(!account)throw new Error('존재하지 않는 계정입니다');
  const{appSecret}=resolveThreadsAppCreds(account);
  try{
    return(await axios.get(`${GRAPH_BASE}/access_token`,{params:{grant_type:'th_exchange_token',client_secret:appSecret,access_token:shortLivedToken},timeout:20000})).data;
  }catch(err){logThreadsError('OAUTH_LONG_TOKEN',err,{accountId});throw err;}
}

async function refreshLongLivedToken(currentToken){
  try{
    return(await axios.get(`${GRAPH_BASE}/refresh_access_token`,{params:{grant_type:'th_refresh_token',access_token:currentToken},timeout:20000})).data;
  }catch(err){logThreadsError('TOKEN_REFRESH',err);throw err;}
}

async function fetchProfile(accessToken,userId){
  try{
    return(await axios.get(`${GRAPH_BASE}/me`,{params:{fields:'username',access_token:accessToken},timeout:15000})).data.username;
  }catch(err){logThreadsError('PROFILE',err,{userId});throw err;}
}

function isRetryablePublishError(err){
  const apiErr=err.response?.data?.error||{},message=String(apiErr.message||err.message||'').toLowerCase();
  return err.response?.status===404||apiErr.code===24||message.includes('requested resource does not exist')||message.includes('media not found')||message.includes('not ready')||message.includes('still processing')||message.includes('processing')||message.includes('please wait')||message.includes('try again');
}

function isTransientThreadsError(err){
  const apiErr=err.response?.data?.error||{};
  const status=Number(err.response?.status||0),code=Number(apiErr.code||0);
  const message=String(apiErr.message||apiErr.error_user_msg||err.message||'').toLowerCase();
  return apiErr.is_transient===true||status>=500||[1,2,4,17,32].includes(code)||message.includes('retry your request later')||message.includes('temporary')||message.includes('temporarily')||message.includes('try again');
}

function isInvalidCarouselChildrenError(err){
  const apiErr=err.response?.data?.error||{};
  const title=String(apiErr.error_user_title||'').toLowerCase();
  const msg=String(apiErr.error_user_msg||apiErr.message||err.message||'').toLowerCase();
  return Number(apiErr.error_subcode)===4279004||title.includes('invalid carousel children')||msg.includes('invalid carousel children')||msg.includes('children with ids');
}

function mediaProcessingError(message,details={}){
  const err=new Error(message);
  err.code='THREADS_MEDIA_PROCESSING_FAILED';
  err.isThreadsMediaProcessingError=true;
  Object.assign(err,details);
  return err;
}
function isMediaProcessingError(err){
  return !!(err?.isThreadsMediaProcessingError||err?.code==='THREADS_MEDIA_PROCESSING_FAILED'||/Threads 미디어 처리 실패|미디어 준비 시간 초과|미디어 컨테이너가 만료/i.test(String(err?.message||'')));
}

async function getContainerStatus(creationId,accessToken){
  try{
    const res=await axios.get(`${GRAPH_BASE}/${creationId}`,{params:{fields:'id,status,error_message',access_token:accessToken},timeout:15000});
    return{id:res.data?.id||creationId,status:String(res.data?.status||'').toUpperCase(),errorMessage:res.data?.error_message||null};
  }catch(err){logThreadsError('MEDIA_STATUS',err,{creationId});throw err;}
}

async function waitForContainerReady(creationId,accessToken,{maxTries=30,waitMs=2000,label='MEDIA'}={}){
  let lastStatus='';
  for(let i=0;i<maxTries;i++){
    const info=await getContainerStatus(creationId,accessToken);
    lastStatus=info.status;
    console.log(`[Threads][${label}_STATUS] creationId=${creationId} status=${info.status||'-'} try=${i+1}/${maxTries}`);
    if(info.status==='FINISHED'||info.status==='PUBLISHED')return info;
    if(info.status==='ERROR')throw mediaProcessingError(`Threads 미디어 처리 실패${info.errorMessage?`: ${info.errorMessage}`:''}`,{creationId,status:info.status,errorMessage:info.errorMessage||null,label});
    if(info.status==='EXPIRED')throw mediaProcessingError('Threads 미디어 컨테이너가 만료되었습니다',{creationId,status:info.status,label});
    if(i<maxTries-1)await sleep(waitMs);
  }
  throw mediaProcessingError(`Threads 미디어 준비 시간 초과 (creationId=${creationId}, status=${lastStatus||'unknown'})`,{creationId,status:lastStatus||'UNKNOWN',label});
}

async function publishContainer(creationId,accessToken,maxTries=5,baseWaitMs=2000){
  let lastError;
  for(let i=0;i<maxTries;i++){
    try{
      console.log(`[Threads][PUBLISH] 시작 creationId=${creationId} try=${i+1}/${maxTries}`);
      const res=await axios.post(`${GRAPH_BASE}/me/threads_publish`,null,{params:{creation_id:creationId,access_token:accessToken},timeout:20000});
      const mediaId=res.data?.id;
      if(!mediaId)throw new Error('Threads 발행 응답에 media id가 없습니다');
      console.log(`[Threads][PUBLISH] 성공 creationId=${creationId} mediaId=${mediaId}`);
      return mediaId;
    }catch(err){
      lastError=err;logThreadsError('PUBLISH',err,{creationId,try:`${i+1}/${maxTries}`});
      if(!isRetryablePublishError(err)||i===maxTries-1)throw err;
      await sleep(Math.min(baseWaitMs+i*2000,12000));
    }
  }
  throw lastError;
}

function normalizeMediaItems(items){
  const out=[];
  for(const x of items||[]){const type=String(x?.type||'').toUpperCase(),url=String(x?.url||'').trim();if(!url||!['IMAGE','VIDEO'].includes(type))continue;if(!out.some(v=>v.type===type&&v.url===url))out.push({type,url});if(out.length>=10)break;}
  return out;
}
function decodeMediaBundle(value){const s=String(value||'');if(!s.startsWith(MEDIA_BUNDLE_PREFIX))return null;try{return normalizeMediaItems(JSON.parse(decodeURIComponent(s.slice(MEDIA_BUNDLE_PREFIX.length))));}catch{return null;}}

async function publishPost(accountId,{text,imageUrl,videoUrl}){
  text=sanitizePublishedThreadsText(text);
  const bundle=decodeMediaBundle(imageUrl);
  if(bundle?.length)return publishMediaItemsPost(accountId,{text,mediaItems:bundle});
  const account=getAccount(accountId);
  if(!account)throw new Error('존재하지 않는 계정입니다');
  if(!account.threads_access_token)throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  if(!account.threads_user_id)throw new Error('Threads User ID가 없습니다. 계정을 다시 연결해주세요.');
  const accessToken=account.threads_access_token,mediaType=videoUrl?'VIDEO':imageUrl?'IMAGE':'TEXT';
  console.log(`[Threads][CREATE] 시작 account=${accountId} userId=${account.threads_user_id} type=${mediaType}`);
  const params={media_type:mediaType,text,access_token:accessToken};if(imageUrl)params.image_url=imageUrl;if(videoUrl)params.video_url=videoUrl;
  let creationId;
  try{const createRes=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params,timeout:30000});creationId=createRes.data?.id;if(!creationId)throw new Error('Threads 컨테이너 생성 응답에 id가 없습니다');console.log(`[Threads][CREATE] 성공 account=${accountId} creationId=${creationId}`);}catch(err){logThreadsError('CREATE',err,{accountId,userId:account.threads_user_id,mediaType});throw err;}
  if(mediaType==='VIDEO'){await waitForContainerReady(creationId,accessToken,{maxTries:40,waitMs:2000,label:'VIDEO'});return publishContainer(creationId,accessToken,10,3000);}
  if(mediaType==='IMAGE')await waitForContainerReady(creationId,accessToken,{maxTries:15,waitMs:1000,label:'IMAGE'});
  return publishContainer(creationId,accessToken,5,2000);
}

async function createCarouselChildContainer(accountId,item,accessToken,{maxTries=3}={}){
  const type=item.type;
  const params={media_type:type,is_carousel_item:true,access_token:accessToken};
  if(type==='VIDEO')params.video_url=item.url;else params.image_url=item.url;
  let lastError;
  for(let i=0;i<maxTries;i++){
    try{
      const res=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params,timeout:30000});
      const id=res.data?.id;
      if(!id)throw new Error('캐러셀 자식 컨테이너 응답에 id가 없습니다');
      console.log(`[Threads][CAROUSEL_CHILD] ${type} ${id} try=${i+1}/${maxTries}`);
      return{id,type,url:item.url};
    }catch(err){
      lastError=err;
      logThreadsError('CAROUSEL_CHILD_CREATE',err,{accountId,type,try:`${i+1}/${maxTries}`,url:item.url});
      if(!isTransientThreadsError(err)||i===maxTries-1)break;
      const waitMs=Math.min(1500+i*2000,6000);
      console.warn(`[Threads][CAROUSEL_CHILD_RETRY] ${type} 일시 오류 → ${waitMs}ms 후 재시도`);
      await sleep(waitMs);
    }
  }
  if(isTransientThreadsError(lastError))throw mediaProcessingError(`Threads 캐러셀 ${type} 생성 일시 실패`,{type,url:item.url,originalError:lastError});
  throw lastError;
}

async function createCarouselParent(accountId,text,children,accessToken,{maxTries=5}={}){
  text=sanitizePublishedThreadsText(text);
  let lastError;const childIds=children.map(x=>x.id);
  for(let i=0;i<maxTries;i++){
    try{
      console.log(`[Threads][CAROUSEL_PARENT] 생성 시도 account=${accountId} try=${i+1}/${maxTries} children=${childIds.join(',')}`);
      const createRes=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params:{media_type:'CAROUSEL',children:childIds.join(','),text,access_token:accessToken},timeout:30000});
      const creationId=createRes.data?.id;if(!creationId)throw new Error('캐러셀 부모 컨테이너 응답에 id가 없습니다');
      console.log(`[Threads][CAROUSEL_PARENT] 생성 성공 creationId=${creationId}`);return creationId;
    }catch(err){lastError=err;logThreadsError('CAROUSEL_CREATE',err,{accountId,try:`${i+1}/${maxTries}`});if(!isInvalidCarouselChildrenError(err)||i===maxTries-1)throw err;console.log('[Threads][CAROUSEL_RETRY] 자식 상태를 다시 확인한 뒤 부모 생성을 재시도합니다');await Promise.all(children.map(child=>waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?20:10,waitMs:2000,label:`CAROUSEL_${child.type}`})));await sleep(Math.min(2000+(i*2000),8000));}
  }
  throw lastError;
}

async function publishMediaItemsPost(accountId,{text,mediaItems}){
  text=sanitizePublishedThreadsText(text);
  const items=normalizeMediaItems(mediaItems);
  if(!items.length)return publishPost(accountId,{text});
  if(items.length===1){
    try{return await publishPost(accountId,{text,imageUrl:items[0].type==='IMAGE'?items[0].url:null,videoUrl:items[0].type==='VIDEO'?items[0].url:null});}
    catch(err){if(!isMediaProcessingError(err)&&!isTransientThreadsError(err))throw err;console.warn(`[Threads][MEDIA_FALLBACK] 단일 ${items[0].type} 실패 → TEXT 발행 url=${items[0].url} reason="${err.message}"`);return publishPost(accountId,{text});}
  }
  const account=getAccount(accountId);if(!account?.threads_access_token)throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  const accessToken=account.threads_access_token;
  console.log(`[Threads][CAROUSEL_CREATE] 시작 account=${accountId} items=${items.length}`);

  const children=[];const createFailed=[];
  for(const item of items){
    try{
      const child=await createCarouselChildContainer(accountId,item,accessToken,{maxTries:3});
      children.push(child);
    }catch(err){
      if(!isMediaProcessingError(err)&&!isTransientThreadsError(err))throw err;
      createFailed.push({item,err});
      console.warn(`[Threads][CAROUSEL_ITEM_CREATE_SKIP] ${item.type} 생성 실패 → 제외 url=${item.url} reason="${err.message}"`);
    }
    await sleep(item.type==='VIDEO'?800:300);
  }

  if(createFailed.length)console.warn(`[Threads][CAROUSEL_CREATE_FALLBACK] 생성 성공=${children.length} 실패=${createFailed.length}`);
  if(!children.length){console.warn('[Threads][CAROUSEL_FALLBACK] 자식 미디어 생성 전부 실패 → TEXT 발행');return publishPost(accountId,{text});}

  console.log(`[Threads][CAROUSEL_WAIT] 자식 ${children.length}개 준비 상태 확인`);
  const readyChildren=[];const failedChildren=[];
  for(const child of children){
    try{
      await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:`CAROUSEL_${child.type}`});
      readyChildren.push(child);
    }catch(err){
      if(!isMediaProcessingError(err))throw err;

      if(child.type==='VIDEO'){
        console.warn(`[Threads][CAROUSEL_VIDEO_RECREATE] 1차 VIDEO 처리 실패 → ffmpeg 정상화 후 새 child 재생성 oldId=${child.id} url=${child.url} reason="${err.message}"`);
        let retryUrl=child.url;
        try{retryUrl=await __me2NormalizeCarouselVideoUrl(child.url);}catch{}
        await sleep(1200);
        try{
          const retryChild=await createCarouselChildContainer(accountId,{type:'VIDEO',url:retryUrl},accessToken,{maxTries:3});
          await waitForContainerReady(retryChild.id,accessToken,{maxTries:40,waitMs:2000,label:'CAROUSEL_VIDEO_RETRY'});
          readyChildren.push(retryChild);
          console.log(`[Threads][CAROUSEL_VIDEO_RECREATE] 성공 oldId=${child.id} newId=${retryChild.id} normalized=${retryUrl!==child.url?'yes':'no'}`);
          continue;
        }catch(retryErr){
          if(!isMediaProcessingError(retryErr)&&!isTransientThreadsError(retryErr))throw retryErr;
          console.error(`[Threads][CAROUSEL_VIDEO_ABORT] 정상화 후 VIDEO도 실패 → 이미지 단독 발행 금지 oldId=${child.id} oldUrl=${child.url} retryUrl=${retryUrl} reason="${retryErr.message}"`);
          throw mediaProcessingError('예약글 VIDEO 정상화 재시도 실패 - 이미지 단독 발행을 차단했습니다',{type:'VIDEO',url:retryUrl,originalError:retryErr});
        }
      }

      failedChildren.push({child,err});
      console.warn(`[Threads][CAROUSEL_ITEM_SKIP] ${child.type} 처리 실패 → 제외 id=${child.id} url=${child.url} reason="${err.message}"`);
    }
  }
  if(failedChildren.length)console.warn(`[Threads][CAROUSEL_FALLBACK] 준비 성공=${readyChildren.length} 실패=${failedChildren.length}`);
  if(!readyChildren.length){console.warn('[Threads][CAROUSEL_FALLBACK] 모든 미디어 처리 실패 → TEXT 발행');return publishPost(accountId,{text});}
  if(readyChildren.length===1){
    const survivor=readyChildren[0];console.warn(`[Threads][CAROUSEL_FALLBACK] 미디어 1개만 정상 → 단일 ${survivor.type}로 재생성 후 발행`);
    try{return await publishPost(accountId,{text,imageUrl:survivor.type==='IMAGE'?survivor.url:null,videoUrl:survivor.type==='VIDEO'?survivor.url:null});}
    catch(err){if(!isMediaProcessingError(err)&&!isTransientThreadsError(err))throw err;console.warn(`[Threads][CAROUSEL_FALLBACK] 남은 ${survivor.type}도 실패 → TEXT 발행 reason="${err.message}"`);return publishPost(accountId,{text});}
  }
  const creationId=await createCarouselParent(accountId,text,readyChildren,accessToken,{maxTries:5});
  try{await waitForContainerReady(creationId,accessToken,{maxTries:30,waitMs:2000,label:'CAROUSEL_PARENT'});return publishContainer(creationId,accessToken,10,3000);}
  catch(err){if(!isMediaProcessingError(err))throw err;console.warn(`[Threads][CAROUSEL_PARENT_FALLBACK] 부모 처리 실패 → 첫 정상 미디어 1개로 발행 reason="${err.message}"`);const survivor=readyChildren[0];try{return await publishPost(accountId,{text,imageUrl:survivor.type==='IMAGE'?survivor.url:null,videoUrl:survivor.type==='VIDEO'?survivor.url:null});}catch(singleErr){if(!isMediaProcessingError(singleErr)&&!isTransientThreadsError(singleErr))throw singleErr;console.warn(`[Threads][CAROUSEL_PARENT_FALLBACK] 단일 미디어도 실패 → TEXT 발행 reason="${singleErr.message}"`);return publishPost(accountId,{text});}}
}

async function publishCarouselPost(accountId,{text,imageUrls}){return publishMediaItemsPost(accountId,{text,mediaItems:(imageUrls||[]).filter(Boolean).map(url=>({type:'IMAGE',url}))});}

async function publishReply(accountId,parentMediaId,text,options={}){
  const account=getAccount(accountId);if(!account)throw new Error('존재하지 않는 계정입니다');if(!account.threads_access_token)throw new Error('스레드 Access Token이 없습니다');const accessToken=account.threads_access_token;
  const guarded=applyCoupangReplyPreviewGuard(text);
  if(options.creationId){
    const status=await getContainerStatus(options.creationId,accessToken);
    if(status.status==='PUBLISHED')throw Object.assign(new Error('기존 댓글이 이미 발행됨: 결과 확인 필요'),{code:'COMMENT_OUTCOME_UNKNOWN'});
    return publishContainer(options.creationId,accessToken,3,2500);
  }
  text=guarded.text;
  console.log(`[Threads][REPLY_PREVIEW_GUARD] account=${accountId} parentMediaId=${parentMediaId} applied=${guarded.guardApplied?'yes':'no'} coupangUrls=${guarded.urlCount} text=${JSON.stringify(text)}`);
  let creationId;
  try{const createRes=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params:{media_type:'TEXT',text,reply_to_id:parentMediaId,access_token:accessToken},timeout:20000});creationId=createRes.data?.id;if(!creationId)throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');console.log(`[Threads][REPLY_CREATE] 성공 account=${accountId} parentMediaId=${parentMediaId} creationId=${creationId}`);}catch(err){logThreadsError('REPLY_CREATE',err,{accountId,parentMediaId});throw err;}
  if(options.onCreated)await options.onCreated(creationId);
  await sleep(2500);
  return publishContainer(creationId,accessToken,3,2500);
}

async function getMediaInsights(accountId,mediaId){
  const account=getAccount(accountId);if(!account||!account.threads_access_token)throw new Error('스레드 Access Token이 없습니다');
  try{const res=await axios.get(`${GRAPH_BASE}/${mediaId}/insights`,{params:{metric:'views,likes,replies,reposts,quotes',access_token:account.threads_access_token},timeout:20000});const data={};for(const item of res.data?.data||[])data[item.name]=item.values?.[0]?.value??item.total_value?.value??0;return data;}catch(err){logThreadsError('INSIGHTS',err,{accountId,mediaId});throw err;}
}

module.exports={getAuthUrl,exchangeCodeForToken,exchangeForLongLivedToken,refreshLongLivedToken,fetchProfile,publishPost,publishCarouselPost,publishMediaItemsPost,publishReply,getMediaInsights};
