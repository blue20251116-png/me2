'use strict';
const { db, getAccount, canPublish, logUsage } = require('./db');
const api = require('./threadsApi');
const cron = require('node-cron');
const { setState } = require('./automationState');
const { classifyPublishFailure, publishRetryable } = require('./publishRetryPolicy');
for (const definition of ['publish_started_at TEXT','publish_creation_id TEXT','publish_retry_count INTEGER DEFAULT 0','publish_next_retry_at TEXT','comment_started_at TEXT','comment_creation_id TEXT','comment_retry_count INTEGER DEFAULT 0','comment_next_retry_at TEXT','recipe_comment_text TEXT']) {
  const name = definition.split(' ')[0];
  if (!db.prepare('PRAGMA table_info(posts)').all().some(c=>c.name===name)) db.exec(`ALTER TABLE posts ADD COLUMN ${definition}`);
}

function retryable(err) { return publishRetryable(err); }
function initializeRecovery() {
  db.prepare("UPDATE posts SET status='failed',error_message='PUBLISH_OUTCOME_UNKNOWN: 재시작 전 발행 결과 확인 필요',publish_next_retry_at=NULL WHERE status='publishing'").run();
  db.prepare("UPDATE posts SET comment_status='failed',comment_error_message='COMMENT_OUTCOME_UNKNOWN: 재시작 전 댓글 결과 확인 필요',comment_next_retry_at=NULL WHERE comment_status='publishing'").run();
}

function startPublishJob({ buildCommentText }) {
  initializeRecovery();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    setState(-1, 'running', 'publish');
    try {
      const now = new Date().toISOString();
      const due = db.prepare("SELECT * FROM posts WHERE status='pending' AND scheduled_at<=? AND (publish_next_retry_at IS NULL OR publish_next_retry_at<=?) ORDER BY scheduled_at,id LIMIT 20").all(now,now);
      for (const post of due) {
        const account = getAccount(post.account_id);
        if (!account?.threads_access_token) { db.prepare("UPDATE posts SET status='failed',error_message='THREADS_TOKEN_MISSING',publish_next_retry_at=NULL WHERE id=? AND status='pending'").run(post.id); continue; }
        if (account.user_id && !canPublish(account.user_id)) { db.prepare("UPDATE posts SET status='failed',error_message='PUBLISH_LIMIT_OR_SUBSCRIPTION',publish_next_retry_at=NULL WHERE id=? AND status='pending'").run(post.id); continue; }
        const claim = db.prepare("UPDATE posts SET status='publishing',publish_started_at=?,publish_next_retry_at=NULL WHERE id=? AND status='pending'").run(new Date().toISOString(),post.id);
        if (!Number(claim.changes)) continue;
        let mediaId;
        try {
          const onCreated = creationId => db.prepare('UPDATE posts SET publish_creation_id=? WHERE id=?').run(String(creationId),post.id);
          if (post.video_url) mediaId = await api.publishPost(account.id,{text:post.text,videoUrl:post.video_url,imageUrl:null,onCreated});
          else if (post.image_url && post.extra_image_url) mediaId = await api.publishCarouselPost(account.id,{text:post.text,imageUrls:[post.image_url,post.extra_image_url],onCreated});
          else mediaId = await api.publishPost(account.id,{text:post.text,imageUrl:post.image_url,videoUrl:null,onCreated});
          if (!mediaId) throw new Error('Threads 발행 응답에 mediaId가 없습니다');
          const postedAt = new Date().toISOString();
          const comment = !!post.auto_comment_enabled && !!(post.link || post.recipe_comment_text);
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare("UPDATE posts SET status='posted',threads_media_id=?,posted_at=?,error_message=NULL,publish_retry_count=0,publish_next_retry_at=NULL,comment_status=?,comment_next_retry_at=?,comment_retry_count=0 WHERE id=?").run(mediaId,postedAt,comment?'pending':'none',comment?new Date(Date.now()+5*60000).toISOString():null,post.id);
            if (account.user_id) logUsage(account.user_id,'publish');
            db.prepare('INSERT INTO insights(post_id,views,likes,replies,reposts,quotes) VALUES(?,0,0,0,0,0) ON CONFLICT(post_id) DO NOTHING').run(post.id);
            db.exec('COMMIT');
          } catch (err) { db.exec('ROLLBACK'); throw err; }
          console.log(`[Publish][COMMITTED] account=${account.id} post=${post.id} mediaId=${mediaId} comment=${comment}`);
        } catch (err) {
          const current = db.prepare('SELECT publish_creation_id,publish_retry_count FROM posts WHERE id=?').get(post.id) || {};
          if (current.publish_creation_id && !err.creationId) err.creationId = current.publish_creation_id;
          const decision = classifyPublishFailure(err,current.publish_retry_count);
          if (mediaId) db.prepare("UPDATE posts SET status='posted',threads_media_id=COALESCE(?,threads_media_id),error_message='ACCOUNTING_REVIEW_REQUIRED',publish_next_retry_at=NULL WHERE id=?").run(mediaId,post.id);
          else if (decision.retry) {
            const next = new Date(Date.now()+decision.retryDelayMs).toISOString();
            db.prepare("UPDATE posts SET status='pending',publish_retry_count=?,publish_next_retry_at=?,publish_started_at=NULL,error_message=? WHERE id=?").run(decision.attempts,next,String(err.code||err.message).slice(0,500),post.id);
            console.warn(`[Publish][RETRY] account=${account.id} post=${post.id} attempts=${decision.attempts}/3 next=${next}`); continue;
          } else {
            const message = decision.outcomeUnknown ? 'PUBLISH_OUTCOME_UNKNOWN: 외부 컨테이너 생성 후 결과 확인 필요' : String(err.code||err.message).slice(0,500);
            db.prepare("UPDATE posts SET status='failed',publish_retry_count=?,publish_next_retry_at=NULL,error_message=? WHERE id=?").run(decision.attempts,message,post.id);
          }
          console.error(`[Publish][FAILED] account=${account.id} post=${post.id} code=${err.code||'PUBLISH_FAILED'} knownMedia=${mediaId||'-'} unknownOutcome=${decision.outcomeUnknown}`);
        }
      }
      const comments = db.prepare("SELECT * FROM posts WHERE status='posted' AND auto_comment_enabled=1 AND comment_status='pending' AND comment_media_id IS NULL AND threads_media_id IS NOT NULL AND comment_next_retry_at<=? ORDER BY comment_next_retry_at,id LIMIT 20").all(new Date().toISOString());
      for (const post of comments) {
        const account = getAccount(post.account_id); if (!account?.threads_access_token) continue;
        if (!Number(db.prepare("UPDATE posts SET comment_status='publishing',comment_started_at=? WHERE id=? AND comment_status='pending'").run(new Date().toISOString(),post.id).changes)) continue;
        try {
          const text = await buildCommentText(account,post); if (!text) throw new Error('댓글 본문이 비어 있습니다');
          const id = await api.publishReply(account.id,post.threads_media_id,text,{creationId:post.comment_creation_id,onCreated: creationId => db.prepare('UPDATE posts SET comment_creation_id=? WHERE id=?').run(creationId,post.id)});
          db.prepare("UPDATE posts SET comment_status='posted',comment_media_id=?,comment_posted_at=?,comment_error_message=NULL,comment_next_retry_at=NULL WHERE id=?").run(id,new Date().toISOString(),post.id);
          console.log(`[Comment][COMMITTED] post=${post.id} mediaId=${id}`);
        } catch (err) {
          const attempts = Number(post.comment_retry_count||0)+1, retry = attempts < 3 && retryable(err);
          db.prepare('UPDATE posts SET comment_status=?,comment_retry_count=?,comment_next_retry_at=?,comment_error_message=? WHERE id=?').run(retry?'pending':'failed',attempts,retry?new Date(Date.now()+attempts*5*60000).toISOString():null,String(err.code||err.message).slice(0,500),post.id);
          console.warn(`[Comment][FAILED] post=${post.id} attempts=${attempts}/3 retry=${retry}`);
        }
      }
    } finally { running=false; setState(-1,'idle','publish tick complete'); }
  };
  cron.schedule('* * * * *',()=>tick().catch(err=>console.error('[Publish][TICK ERROR]',err.message)),{noOverlap:true});
  console.log('[Publish][QUEUE] atomic claims + safe bounded pre-creation retries + persisted outcomes');
  return tick;
}
module.exports = { startPublishJob, retryable, initializeRecovery };
