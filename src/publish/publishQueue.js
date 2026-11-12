'use strict';
const { db, getAccount, canPublish, logUsage } = require('../infra/db');
const api = require('../threads/threadsApi');
const cron = require('node-cron');
const { setState } = require('../infra/automationState');
const { classifyPublishFailure, publishRetryable, publishErrorText } = require('./publishRetryPolicy');
const { UPLOADS_DIR } = require('../config/paths');
const { postVideoDurationSec } = require('../threads/videoDuration');
const { withBodyDisclosure } = require('./commentText');
const { sanitizePublishedThreadsText } = require('../threads/publishText');
const { reconcileUnknownPublishes, checkBeforeRetry } = require('./publishRecovery');

// 2026-11-05 (dev 0079f189): the video file is deleted after posting, so its length is saved on the row at
// publish time (when the reservation did not already record it). Never affects the publish itself.
function recordPublishedVideoDuration(post, uploadsDir = UPLOADS_DIR) {
  try {
    if (post?.video_duration_sec != null) return null;
    const sec = postVideoDurationSec(post, uploadsDir);
    if (sec == null) return null;
    db.prepare('UPDATE posts SET video_duration_sec=? WHERE id=? AND video_duration_sec IS NULL').run(sec, post.id);
    return sec;
  } catch (e) {
    console.warn(`[Publish][VIDEO DURATION] post=${post?.id} 기록 실패 reason="${e.message}"`);
    return null;
  }
}
// Column migrations must not crash the boot on a full disk (the process keeps serving).
try {
  for (const definition of [
    'publish_started_at TEXT',
    'publish_creation_id TEXT',
    'publish_retry_count INTEGER DEFAULT 0',
    'publish_next_retry_at TEXT',
    'comment_started_at TEXT',
    'comment_creation_id TEXT',
    'comment_retry_count INTEGER DEFAULT 0',
    'comment_next_retry_at TEXT',
    'recipe_comment_text TEXT',
    'comment_verified_at TEXT',
    // 2026-11-05 (marketing c1266546): the body exactly as sent (withBodyDisclosure adds the Coupang line
    // at publish time, so posts.text never shows it), whether the disclosure was in it, the one-time
    // recovery marker for unknown outcomes, and the permalink of a post found live by recovery.
    'sent_text TEXT',
    'disclosure_in_body INTEGER',
    'publish_recovered_at TEXT',
    'threads_permalink TEXT',
  ]) {
    const name = definition.split(' ')[0];
    if (
      !db
        .prepare('PRAGMA table_info(posts)')
        .all()
        .some(c => c.name === name)
    )
      db.exec(`ALTER TABLE posts ADD COLUMN ${definition}`);
  }
} catch (e) {
  console.error('[PublishQueue][INIT] posts 컬럼 마이그레이션 실패 (디스크 문제로 추정) - 계속 부팅합니다:', e.message);
}

function retryable(err) {
  return publishRetryable(err);
}
function initializeRecovery() {
  // Posts caught mid-publish by a restart are marked for review, never re-posted blindly.
  try {
    db.prepare(
      "UPDATE posts SET status='failed',error_message='PUBLISH_OUTCOME_UNKNOWN: 재시작 전 발행 결과 확인 필요',publish_next_retry_at=NULL WHERE status='publishing'"
    ).run();
    db.prepare(
      "UPDATE posts SET comment_status='failed',comment_error_message='COMMENT_OUTCOME_UNKNOWN: 재시작 전 댓글 결과 확인 필요',comment_next_retry_at=NULL WHERE comment_status='publishing'"
    ).run();
  } catch (e) {
    console.error('[PublishQueue][INIT] 복구 초기화 실패 (디스크 문제로 추정) - 계속 부팅합니다:', e.message);
  }
}

// 2026-11-05 (11/05 review): reads each posted auto-comment back once (threadsApi.verifyReply, read-only GET)
// and fills comment_verified_at. A definite miss is written to comment_error_message (COMMENT_VERIFY_FAILED)
// and never re-posted automatically (that could double the comment); transient errors retry next tick.
// Only comments from the last 7 days, a few per tick, at least a minute after posting.
const VERIFY_PER_TICK = 5;
async function verifyPostedComments() {
  if (typeof api.verifyReply !== 'function') return 0;
  const rows = db
    .prepare(
      "SELECT id,account_id,threads_media_id,comment_media_id FROM posts WHERE comment_status='posted' AND comment_media_id IS NOT NULL AND threads_media_id IS NOT NULL AND comment_verified_at IS NULL AND comment_error_message IS NULL AND comment_posted_at<=? AND comment_posted_at>=? ORDER BY comment_posted_at LIMIT ?"
    )
    .all(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 7 * 86400000).toISOString(), VERIFY_PER_TICK);
  let verified = 0;
  for (const row of rows) {
    try {
      const result = await api.verifyReply(row.account_id, row.comment_media_id, row.threads_media_id);
      if (result?.verified) {
        db.prepare('UPDATE posts SET comment_verified_at=? WHERE id=? AND comment_verified_at IS NULL').run(
          new Date().toISOString(),
          row.id
        );
        verified++;
      } else {
        db.prepare('UPDATE posts SET comment_error_message=? WHERE id=?').run(
          `COMMENT_VERIFY_FAILED: ${result?.reason || 'unknown'}`.slice(0, 500),
          row.id
        );
        console.warn(`[Comment][VERIFY FAILED] post=${row.id} reason=${result?.reason || 'unknown'}`);
      }
    } catch (err) {
      const status = Number(err?.response?.status || 0);
      // 4xx other than rate limits will not fix itself (permissions, bad id): record once, stop asking.
      if (status >= 400 && status < 500 && status !== 429) {
        db.prepare('UPDATE posts SET comment_error_message=? WHERE id=?').run(
          `COMMENT_VERIFY_FAILED: HTTP ${status}`,
          row.id
        );
      }
      console.warn(`[Comment][VERIFY ERROR] post=${row.id} status=${status || '-'} ${String(err.message).slice(0, 120)}`);
    }
  }
  return verified;
}

function startPublishJob({ buildCommentText }) {
  initializeRecovery();
  let running = false;
  const tick = async () => {
    if (running || draining) return;
    running = publishing = true;
    setState(-1, 'running', 'publish');
    try {
      const now = new Date().toISOString();
      const due = db
        .prepare(
          "SELECT * FROM posts WHERE status='pending' AND scheduled_at<=? AND (publish_next_retry_at IS NULL OR publish_next_retry_at<=?) ORDER BY scheduled_at,id LIMIT 20"
        )
        .all(now, now);
      for (const post of due) {
        if (draining) break; // shutdown requested: finish the post in flight, claim no new one
        const account = getAccount(post.account_id);
        if (!account?.threads_access_token) {
          db.prepare(
            "UPDATE posts SET status='failed',error_message='THREADS_TOKEN_MISSING',publish_next_retry_at=NULL WHERE id=? AND status='pending'"
          ).run(post.id);
          continue;
        }
        if (account.user_id && !canPublish(account.user_id)) {
          db.prepare(
            "UPDATE posts SET status='failed',error_message='PUBLISH_LIMIT_OR_SUBSCRIPTION',publish_next_retry_at=NULL WHERE id=? AND status='pending'"
          ).run(post.id);
          continue;
        }
        const claim = db
          .prepare(
            "UPDATE posts SET status='publishing',publish_started_at=?,publish_next_retry_at=NULL WHERE id=? AND status='pending'"
          )
          .run(new Date().toISOString(), post.id);
        if (!Number(claim.changes)) continue;
        // A retry whose earlier attempt already created a container is re-sent only if that container
        // was not published (never a double post).
        if (!(await checkBeforeRetry(post))) continue;
        let mediaId;
        try {
          const onCreated = creationId =>
            db.prepare('UPDATE posts SET publish_creation_id=? WHERE id=?').run(String(creationId), post.id);
          // 2026-11-05 (marketing c1266546): store the body exactly as sent and whether the disclosure
          // is in it, so the body disclosure can be verified from the DB.
          const sentText = withBodyDisclosure(post.text, post.link);
          const storedText = sanitizePublishedThreadsText(sentText);
          db.prepare('UPDATE posts SET sent_text=?,disclosure_in_body=? WHERE id=?').run(
            storedText,
            /쿠팡\s*파트너스/.test(storedText) ? 1 : 0,
            post.id
          );
          if (post.video_url)
            mediaId = await api.publishPost(account.id, {
              text: sentText,
              videoUrl: post.video_url,
              imageUrl: null,
              onCreated,
            });
          else if (post.image_url && post.extra_image_url)
            mediaId = await api.publishCarouselPost(account.id, {
              text: sentText,
              imageUrls: [post.image_url, post.extra_image_url],
              onCreated,
            });
          else
            mediaId = await api.publishPost(account.id, {
              text: sentText,
              imageUrl: post.image_url,
              videoUrl: null,
              onCreated,
            });
          if (!mediaId) throw new Error('Threads 발행 응답에 mediaId가 없습니다');
          const postedAt = new Date().toISOString();
          const comment = !!post.auto_comment_enabled && !!(post.link || post.recipe_comment_text);
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(
              "UPDATE posts SET status='posted',threads_media_id=?,posted_at=?,error_message=NULL,publish_retry_count=0,publish_next_retry_at=NULL,comment_status=?,comment_next_retry_at=?,comment_retry_count=0 WHERE id=?"
            ).run(
              mediaId,
              postedAt,
              comment ? 'pending' : 'none',
              comment ? new Date(Date.now() + 5 * 60000).toISOString() : null,
              post.id
            );
            if (account.user_id) logUsage(account.user_id, 'publish');
            db.prepare(
              'INSERT INTO insights(post_id,views,likes,replies,reposts,quotes) VALUES(?,0,0,0,0,0) ON CONFLICT(post_id) DO NOTHING'
            ).run(post.id);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
          console.log(
            `[Publish][COMMITTED] account=${account.id} post=${post.id} mediaId=${mediaId} comment=${comment}`
          );
          recordPublishedVideoDuration(post);
        } catch (err) {
          // Ambiguous failures (the publish call itself errored) arrive tagged with creationId by
          // threadsApi; publish_creation_id is only a diagnostic trail, so a transient error while
          // a container was merely being prepared stays retryable.
          const current = db.prepare('SELECT publish_retry_count FROM posts WHERE id=?').get(post.id) || {};
          const decision = classifyPublishFailure(err, current.publish_retry_count);
          if (mediaId)
            db.prepare(
              "UPDATE posts SET status='posted',threads_media_id=COALESCE(?,threads_media_id),error_message='ACCOUNTING_REVIEW_REQUIRED',publish_next_retry_at=NULL WHERE id=?"
            ).run(mediaId, post.id);
          else if (decision.retry) {
            const next = new Date(Date.now() + decision.retryDelayMs).toISOString();
            db.prepare(
              "UPDATE posts SET status='pending',publish_retry_count=?,publish_next_retry_at=?,publish_started_at=NULL,error_message=? WHERE id=?"
            ).run(decision.attempts, next, publishErrorText(err), post.id);
            console.warn(
              `[Publish][RETRY] account=${account.id} post=${post.id} attempts=${decision.attempts}/3 next=${next}`
            );
            continue;
          } else {
            const message = decision.outcomeUnknown
              ? 'PUBLISH_OUTCOME_UNKNOWN: 외부 컨테이너 생성 후 결과 확인 필요'
              : publishErrorText(err);
            db.prepare(
              "UPDATE posts SET status='failed',publish_retry_count=?,publish_next_retry_at=NULL,error_message=? WHERE id=?"
            ).run(decision.attempts, message, post.id);
          }
          console.error(
            `[Publish][FAILED] account=${account.id} post=${post.id} code=${err.code || 'PUBLISH_FAILED'} detail=${JSON.stringify(publishErrorText(err, 300))} knownMedia=${mediaId || '-'} unknownOutcome=${decision.outcomeUnknown}`
          );
        }
      }
      const comments = db
        .prepare(
          "SELECT * FROM posts WHERE status='posted' AND auto_comment_enabled=1 AND comment_status='pending' AND comment_media_id IS NULL AND threads_media_id IS NOT NULL AND comment_next_retry_at<=? ORDER BY comment_next_retry_at,id LIMIT 20"
        )
        .all(new Date().toISOString());
      for (const post of comments) {
        if (draining) break;
        const account = getAccount(post.account_id);
        if (!account?.threads_access_token) continue;
        if (
          !Number(
            db
              .prepare(
                "UPDATE posts SET comment_status='publishing',comment_started_at=? WHERE id=? AND comment_status='pending'"
              )
              .run(new Date().toISOString(), post.id).changes
          )
        )
          continue;
        try {
          const text = await buildCommentText(account, post);
          if (!text) throw new Error('댓글 본문이 비어 있습니다');
          const id = await api.publishReply(account.id, post.threads_media_id, text, {
            creationId: post.comment_creation_id,
            onCreated: creationId =>
              db.prepare('UPDATE posts SET comment_creation_id=? WHERE id=?').run(creationId, post.id),
          });
          db.prepare(
            "UPDATE posts SET comment_status='posted',comment_media_id=?,comment_posted_at=?,comment_error_message=NULL,comment_next_retry_at=NULL WHERE id=?"
          ).run(id, new Date().toISOString(), post.id);
          console.log(`[Comment][COMMITTED] post=${post.id} mediaId=${id}`);
        } catch (err) {
          const attempts = Number(post.comment_retry_count || 0) + 1,
            retry = attempts < 3 && retryable(err);
          db.prepare(
            'UPDATE posts SET comment_status=?,comment_retry_count=?,comment_next_retry_at=?,comment_error_message=? WHERE id=?'
          ).run(
            retry ? 'pending' : 'failed',
            attempts,
            retry ? new Date(Date.now() + attempts * 5 * 60000).toISOString() : null,
            String(err.code || err.message).slice(0, 500),
            post.id
          );
          console.warn(`[Comment][FAILED] post=${post.id} attempts=${attempts}/3 retry=${retry}`);
        }
      }
      if (!draining) await verifyPostedComments();
      if (!draining) await reconcileUnknownPublishes({ shouldStop: () => draining });
    } finally {
      running = publishing = false;
      setState(-1, 'idle', 'publish tick complete');
    }
  };
  cron.schedule('* * * * *', () => tick().catch(err => console.error('[Publish][TICK ERROR]', err.message)), {
    noOverlap: true,
  });
  console.log('[Publish][QUEUE] atomic claims + safe bounded pre-creation retries + persisted outcomes');
  return tick;
}
// True while a publish tick is talking to Threads; shutdown waits for it so a post is never cut off
// between container creation and publish.
let publishing = false;
const isPublishing = () => publishing;
// 2026-11-05 (marketing c1266546): set by graceful shutdown; the running tick finishes the post it is
// sending and then stops, and no new tick starts.
let draining = false;
const requestDrain = () => {
  draining = true;
};
module.exports = { requestDrain, startPublishJob, retryable, initializeRecovery, isPublishing, recordPublishedVideoDuration, verifyPostedComments };
