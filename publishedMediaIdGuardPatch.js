const axios=require('axios');
const threadsApi=require('./threadsApi');
const {db,getAccount}=require('./db');
const GRAPH_BASE='https://graph.threads.net/v1.0';

async function validateMediaId(accountId,mediaId,{tries=4,waitMs=1200}={}){
  const account=getAccount(accountId);if(!account?.threads_access_token||!mediaId)return false;
  for(let i=0;i<tries;i++){
    try{
      const r=await axios.get(`${GRAPH_BASE}/${mediaId}`,{params:{fields:'id,permalink',access_token:account.threads_access_token},timeout:12000});
      if(String(r.data?.id||'')===String(mediaId))return true;
    }catch(err){
      const code=Number(err.response?.data?.error?.code||0),sub=Number(err.response?.data?.error?.error_subcode||0);
      if((code===100&&sub===33)||code===24)break;
    }
    if(i<tries-1)await new Promise(r=>setTimeout(r,waitMs*(i+1)));
  }
  return false;
}

function wrapPublisher(name){
  const original=threadsApi[name];if(typeof original!=='function')return;
  threadsApi[name]=async function guardedPublisher(accountId,...args){
    const mediaId=await original.call(this,accountId,...args);
    if(!mediaId)throw new Error('Threads 발행 결과 mediaId가 없습니다');
    const valid=await validateMediaId(accountId,mediaId);
    if(!valid){
      const err=new Error(`Threads publish 응답 mediaId 검증 실패: ${mediaId}`);err.code='INVALID_PUBLISHED_MEDIA_ID';throw err;
    }
    console.log(`[Threads][PUBLISHED MEDIA VERIFY] account=${accountId} mediaId=${mediaId} verified=yes`);
    return mediaId;
  };
}
wrapPublisher('publishPost');
wrapPublisher('publishCarouselPost');

async function quarantineStaleIds(){
  let rows=[];try{rows=db.prepare(`SELECT id,account_id,threads_media_id,comment_status FROM posts WHERE status='posted' AND threads_media_id IS NOT NULL AND posted_at>=? ORDER BY id DESC LIMIT 80`).all(new Date(Date.now()-48*60*60*1000).toISOString());}catch{return;}
  for(const row of rows){
    const valid=await validateMediaId(row.account_id,row.threads_media_id,{tries:1});
    if(valid)continue;
    const msg=`stale/invalid Threads mediaId quarantined: ${row.threads_media_id}`;
    try{db.prepare(`UPDATE posts SET threads_media_id=NULL, comment_status=CASE WHEN auto_comment_enabled=1 THEN 'failed' ELSE comment_status END, comment_error_message=CASE WHEN auto_comment_enabled=1 THEN ? ELSE comment_error_message END, comment_scheduled_at=NULL, comment_next_retry_at=NULL WHERE id=?`).run(msg,row.id);}catch{try{db.prepare(`UPDATE posts SET threads_media_id=NULL WHERE id=?`).run(row.id);}catch{}}
    console.warn(`[Threads][MEDIA ID QUARANTINE] post #${row.id} account #${row.account_id} invalid=${row.threads_media_id}`);
  }
}
setTimeout(()=>quarantineStaleIds().catch(e=>console.warn(`[Threads][MEDIA ID QUARANTINE] ${e.message}`)),12000);

module.exports={validateMediaId};
console.log('[Threads][PUBLISHED MEDIA ID GUARD] publish 응답 mediaId 검증 + 최근 stale mediaId 격리 활성화');
