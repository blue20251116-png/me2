const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

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
    const info={id:res.data?.id||creationId,status:String(res.data?.status||'').toUpperCase(),errorMessage:res.data?.error_message||null,raw:res.data||{}};
    if(info.status==='ERROR'||info.errorMessage){
      console.error(`[Threads][MEDIA_STATUS_DETAIL] creationId=${creationId} status=${info.status||'-'} errorMessage=${JSON.stringify(info.errorMessage)} raw=${JSON.stringify(info.raw)}`);
    }
    return info;
  }catch(err){logThreadsError('MEDIA_STATUS',err,{creationId});throw err;}
}

async function waitForContainerReady(creationId,accessToken,{maxTries=30,waitMs=2000,label='MEDIA'}={}){
  let lastStatus='',lastInfo=null;
  for(let i=0;i<maxTries;i++){
    const info=await getContainerStatus(creationId,accessToken);
    lastInfo=info;lastStatus=info.status;
    console.log(`[Threads][${label}_STATUS] creationId=${creationId} status=${info.status||'-'} errorMessage=${info.errorMessage?JSON.stringify(info.errorMessage):'-'} try=${i+1}/${maxTries}`);
    if(info.status==='FINISHED'||info.status==='PUBLISHED')return info;
    if(info.status==='ERROR'){
      console.error(`[Threads][${label}_ERROR_DETAIL] creationId=${creationId} status=${info.status} errorMessage=${JSON.stringify(info.errorMessage)} raw=${JSON.stringify(info.raw||{})}`);
      throw mediaProcessingError(`Threads 미디어 처리 실패${info.errorMessage?`: ${info.errorMessage}`:''}`,{creationId,status:info.status,errorMessage:info.errorMessage||null,label,raw:info.raw||{}});
    }
    if(info.status==='EXPIRED')throw mediaProcessingError('Threads 미디어 컨테이너가 만료되었습니다',{creationId,status:info.status,label,raw:info.raw||{}});
    if(i<maxTries-1)await sleep(waitMs);
  }
  console.error(`[Threads][${label}_TIMEOUT_DETAIL] creationId=${creationId} status=${lastStatus||'UNKNOWN'} raw=${JSON.stringify(lastInfo?.raw||{})}`);
  throw mediaProcessingError(`Threads 미디어 준비 시간 초과 (creationId=${creationId}, status=${lastStatus||'unknown'})`,{creationId,status:lastStatus||'UNKNOWN',label,errorMessage:lastInfo?.errorMessage||null,raw:lastInfo?.raw||{}});
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
  try{const createRes=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params,timeout:30000});creationId=createRes.data?.id;if(!creationId)throw new Error('Threads 컨테이너 생성 응답에 id가 없습니다');console.log(`[Threads][CREATE] 성공 account=${accountId} creationId=${creationId} response=${JSON.stringify(createRes.data||{})}`);}catch(err){logThreadsError('CREATE',err,{accountId,userId:account.threads_user_id,mediaType});throw err;}
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
      console.log(`[Threads][CAROUSEL_CHILD] ${type} ${id} try=${i+1}/${maxTries} response=${JSON.stringify(res.data||{})} url=${item.url}`);
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
  const items=normalizeMediaItems(mediaItems);
  if(!items.length)throw mediaProcessingError('Threads 원본 미디어 항목이 없습니다',{accountId,expectedCount:0});
  if(items.length===1){
    try{return await publishPost(accountId,{text,imageUrl:items[0].type==='IMAGE'?items[0].url:null,videoUrl:items[0].type==='VIDEO'?items[0].url:null});}
    catch(err){
      console.error(`[Threads][MEDIA_REQUIRED_FAIL] 단일 ${items[0].type} 처리 실패 → 소재 전체 실패 url=${items[0].url} reason=${JSON.stringify(err?.message||String(err))}`);
      throw err;
    }
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
      console.error(`[Threads][CAROUSEL_ITEM_CREATE_FAIL] ${item.type} 생성 실패 url=${item.url} reason=${JSON.stringify(err?.message||String(err))}`);
    }
    await sleep(item.type==='VIDEO'?800:300);
  }

  if(children.length!==items.length){
    const failedSummary=createFailed.map(x=>({type:x.item.type,url:x.item.url,message:String(x.err?.message||x.err),code:x.err?.code||null,errorMessage:x.err?.errorMessage||null,status:x.err?.status||null,raw:x.err?.raw||null}));
    console.error(`[Threads][CAROUSEL_REQUIRED_FAIL] 생성 단계 일부 실패 expected=${items.length} created=${children.length} failed=${JSON.stringify(failedSummary)}`);
    throw mediaProcessingError(`Threads 원본 미디어 ${items.length}개 중 ${children.length}개만 컨테이너 생성 성공`,{accountId,expectedCount:items.length,createdCount:children.length,failed:failedSummary});
  }

  console.log(`[Threads][CAROUSEL_WAIT] 자식 ${children.length}개 준비 상태 확인`);
  const readyChildren=[];const failedChildren=[];
  for(const child of children){
    try{
      await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:`CAROUSEL_${child.type}`});
      readyChildren.push(child);
    }catch(err){
      if(!isMediaProcessingError(err))throw err;
      failedChildren.push({child,err});
      console.error(`[Threads][CAROUSEL_ITEM_PROCESS_FAIL] ${child.type} 처리 실패 id=${child.id} url=${child.url} reason=${JSON.stringify(err?.message||String(err))} status=${err?.status||'-'} errorMessage=${JSON.stringify(err?.errorMessage||null)} raw=${JSON.stringify(err?.raw||{})}`);
    }
  }

  if(readyChildren.length!==items.length){
    const failedSummary=failedChildren.map(x=>({id:x.child.id,type:x.child.type,url:x.child.url,message:String(x.err?.message||x.err),status:x.err?.status||null,errorMessage:x.err?.errorMessage||null,raw:x.err?.raw||null}));
    console.error(`[Threads][CAROUSEL_REQUIRED_FAIL] 준비 단계 일부 실패 expected=${items.length} ready=${readyChildren.length} failed=${JSON.stringify(failedSummary)}`);
    throw mediaProcessingError(`Threads 원본 미디어 ${items.length}개 중 ${readyChildren.length}개만 처리 완료`,{accountId,expectedCount:items.length,readyCount:readyChildren.length,failed:failedSummary});
  }

  const creationId=await createCarouselParent(accountId,text,readyChildren,accessToken,{maxTries:5});
  try{
    await waitForContainerReady(creationId,accessToken,{maxTries:30,waitMs:2000,label:'CAROUSEL_PARENT'});
    return publishContainer(creationId,accessToken,10,3000);
  }catch(err){
    console.error(`[Threads][CAROUSEL_PARENT_FAIL] 부모 캐러셀 처리 실패 → 소재 전체 실패 creationId=${creationId} reason=${JSON.stringify(err?.message||String(err))} status=${err?.status||'-'} errorMessage=${JSON.stringify(err?.errorMessage||null)} raw=${JSON.stringify(err?.raw||{})}`);
    throw err;
  }
}

async function publishCarouselPost(accountId,{text,imageUrls}){return publishMediaItemsPost(accountId,{text,mediaItems:(imageUrls||[]).filter(Boolean).map(url=>({type:'IMAGE',url}))});}

async function publishReply(accountId,parentMediaId,text){
  const account=getAccount(accountId);if(!account)throw new Error('존재하지 않는 계정입니다');if(!account.threads_access_token)throw new Error('스레드 Access Token이 없습니다');const accessToken=account.threads_access_token;
  let creationId;
  try{const createRes=await axios.post(`${GRAPH_BASE}/me/threads`,null,{params:{media_type:'TEXT',text,reply_to_id:parentMediaId,access_token:accessToken},timeout:20000});creationId=createRes.data?.id;if(!creationId)throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');}catch(err){logThreadsError('REPLY_CREATE',err,{accountId,parentMediaId});throw err;}
  return publishContainer(creationId,accessToken,5,2000);
}

async function getMediaInsights(accountId,mediaId){
  const account=getAccount(accountId);if(!account||!account.threads_access_token)throw new Error('스레드 Access Token이 없습니다');
  try{const res=await axios.get(`${GRAPH_BASE}/${mediaId}/insights`,{params:{metric:'views,likes,replies,reposts,quotes',access_token:account.threads_access_token},timeout:20000});const data={};for(const item of res.data?.data||[])data[item.name]=item.values?.[0]?.value??item.total_value?.value??0;return data;}catch(err){logThreadsError('INSIGHTS',err,{accountId,mediaId});throw err;}
}

module.exports={getAuthUrl,exchangeCodeForToken,exchangeForLongLivedToken,refreshLongLivedToken,fetchProfile,publishPost,publishCarouselPost,publishMediaItemsPost,publishReply,getMediaInsights};