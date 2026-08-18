const cron=require('node-cron');
const axios=require('axios');
const {db,getAccount}=require('./db');
const threadsApi=require('./threadsApi');

const originalPublishReply=threadsApi.publishReply.bind(threadsApi);
const GRAPH_BASE='https://graph.threads.net/v1.0';
const DELAY_MS=5*60*1000;
const MAX_RETRIES=3;
const SENTINEL='__DELAYED_COMMENT__';
const DEFAULT_DISCLOSURE='이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

for(const sql of[
  `ALTER TABLE posts ADD COLUMN comment_scheduled_at TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_verified_at TEXT`
]){try{db.exec(sql);}catch{}}

db.exec(`
CREATE TRIGGER IF NOT EXISTS delayed_comment_guard
AFTER UPDATE OF comment_media_id ON posts
WHEN NEW.comment_media_id LIKE '${SENTINEL}%'
BEGIN
  UPDATE posts SET comment_status='scheduled',comment_media_id=NULL,comment_posted_at=NULL WHERE id=NEW.id;
END;
`);

function isCoupangLink(link){return /(^|\.)coupang\.com|link\.coupang\.com/i.test(String(link||''));}
function disclosure(account,link){
  if(!isCoupangLink(link))return'';
  const raw=String(account?.coupang_disclosure_template||`${DEFAULT_DISCLOSURE}\n\n{link}`);
  return raw.replace(/\{link\}/g,'').replace(/\n{3,}/g,'\n\n').trim()||DEFAULT_DISCLOSURE;
}
function buildComment(account,post){
  const link=String(post?.link||'').trim();
  const links=link?`${link}\n${link}`:'';
  const tail=[links,disclosure(account,link)].filter(Boolean).join('\n\n');
  const cap=490;
  if(tail.length>cap)throw new Error('댓글 링크/고지 영역이 490자를 초과했습니다');
  const room=Math.max(0,cap-tail.length-(tail?2:0));
  let head=String(post?.recipe_comment_text||'').replace(/\r/g,'').trim();
  if(head.length>room){
    const lines=head.split('\n').map(x=>x.trim()).filter(Boolean);
    const keep=[];let used=0;
    for(const line of lines){const add=(keep.length?1:0)+line.length;if(used+add>room)break;keep.push(line);used+=add;}
    head=keep.join('\n');
    if(!head&&room>1)head=String(post?.recipe_comment_text||'').slice(0,room-1).trimEnd()+'…';
  }
  return[head,tail].filter(Boolean).join('\n\n').slice(0,cap);
}
async function verifyComment(account,commentId){
  try{
    const r=await axios.get(`${GRAPH_BASE}/${commentId}`,{params:{fields:'id,text',access_token:account.threads_access_token},timeout:15000});
    return String(r.data?.id||'')===String(commentId);
  }catch(err){
    console.warn(`[댓글 검증] comment=${commentId} API 확인 실패: ${err.response?.data?.error?.message||err.message}`);
    return false;
  }
}
function schedulePostComment(postId,postedAt){
  const base=Date.parse(postedAt||'');
  const when=new Date((Number.isFinite(base)?base:Date.now())+DELAY_MS).toISOString();
  db.prepare(`UPDATE posts SET comment_status='scheduled',comment_scheduled_at=?,comment_error_message=NULL WHERE id=?`).run(when,postId);
  console.log(`[댓글 예약] post #${postId} 본문 발행 5분 후=${when}`);
  return when;
}

threadsApi.publishReply=async function delayedPublishReply(accountId,parentMediaId,text){
  const post=db.prepare(`SELECT id,posted_at,comment_status FROM posts WHERE account_id=? AND threads_media_id=? ORDER BY id DESC LIMIT 1`).get(Number(accountId),String(parentMediaId));
  if(!post)return originalPublishReply(accountId,parentMediaId,text);
  schedulePostComment(post.id,post.posted_at);
  return `${SENTINEL}${post.id}`;
};

async function processScheduledComments(){
  const now=new Date().toISOString();
  const due=db.prepare(`SELECT * FROM posts WHERE status='posted' AND auto_comment_enabled=1 AND comment_status='scheduled' AND comment_media_id IS NULL AND threads_media_id IS NOT NULL AND comment_scheduled_at IS NOT NULL AND comment_scheduled_at<=? ORDER BY comment_scheduled_at ASC LIMIT 10`).all(now);
  for(const post of due){
    const account=getAccount(post.account_id);
    if(!account?.threads_access_token)continue;
    try{
      const text=buildComment(account,post);
      if(!text){db.prepare(`UPDATE posts SET comment_status='none',comment_scheduled_at=NULL WHERE id=?`).run(post.id);continue;}
      console.log(`[댓글 5분후 발행] account #${account.id} post #${post.id} length=${text.length}`);
      const commentId=await originalPublishReply(account.id,post.threads_media_id,text);
      const verified=await verifyComment(account,commentId);
      const postedAt=new Date().toISOString();
      db.prepare(`UPDATE posts SET comment_status='posted',comment_media_id=?,comment_posted_at=?,comment_verified_at=?,comment_error_message=NULL,comment_retry_count=0,comment_next_retry_at=NULL,comment_scheduled_at=NULL WHERE id=?`).run(commentId,postedAt,verified?postedAt:null,post.id);
      console.log(`[댓글 등록 완료][DELAYED] post #${post.id} comment=${commentId} verified=${verified?'yes':'pending'}`);
    }catch(err){
      const retry=Number(post.comment_retry_count||0)+1;
      const msg=err.response?.data?.error?.message||err.message;
      if(retry<MAX_RETRIES){
        const next=new Date(Date.now()+5*60*1000).toISOString();
        db.prepare(`UPDATE posts SET comment_status='scheduled',comment_error_message=?,comment_retry_count=?,comment_scheduled_at=? WHERE id=?`).run(msg,retry,next,post.id);
        console.error(`[댓글 지연발행 실패] post #${post.id} retry=${retry}/${MAX_RETRIES} next=${next} reason="${msg}"`);
      }else{
        db.prepare(`UPDATE posts SET comment_status='failed',comment_error_message=?,comment_retry_count=?,comment_scheduled_at=NULL,comment_next_retry_at=NULL WHERE id=?`).run(msg,retry,post.id);
        console.error(`[댓글 지연발행 최종실패] post #${post.id} retry=${retry}/${MAX_RETRIES} reason="${msg}"`);
      }
    }
  }
}

cron.schedule('* * * * *',()=>processScheduledComments().catch(e=>console.error('[댓글 지연 스케줄러]',e.message)));
console.log('[댓글 DELAY PATCH] 모든 계정 본문 5분 후 댓글 + 등록 검증 활성화');
