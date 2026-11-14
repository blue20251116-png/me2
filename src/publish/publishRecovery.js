'use strict';
// 2026-11-05 (marketing c1266546): posts lost mid-publish (#8752 PUBLISH_OUTCOME_UNKNOWN at a restart,
// #8798 ERR_CANCELED) stayed 'failed' forever although neither went live. This resolves them with
// read-only Threads GETs and never posts anything itself:
//   - live (a recent post of the account matches the sent text, published after the attempt started)
//     -> marked posted with its media id/permalink (and its auto-comment queued as for a normal post);
//   - container PUBLISHED but no matching post found -> left failed for a human (never re-posted);
//   - not live -> re-queued once (publish_recovered_at marks the one recovery), only while the slot is
//     recent (PUBLISH_RECOVERY_REQUEUE_HOURS, default 12); older ones are only marked PUBLISH_NOT_LIVE.
// A post can only go live through threads_publish, and threadsApi records publish_creation_id before
// every threads_publish call, so "no creation id + no matching post" is a safe re-queue.
const { db, getAccount, logUsage } = require('../infra/db');
const api = require('../threads/threadsApi');
const { withBodyDisclosure } = require('./commentText');
const { sanitizePublishedThreadsText } = require('../threads/publishText');

const RECOVERY_PER_TICK = 5;
const LOOKBACK_MS = 48 * 3600000;
const requeueWindowMs = () => Math.max(0, Number(process.env.PUBLISH_RECOVERY_REQUEUE_HOURS ?? 12) || 0) * 3600000;

// The body exactly as the queue sends it (threadsApi sanitizes again; sanitizing is idempotent).
function sentTextFor(post) {
  let text;
  try {
    text = withBodyDisclosure(post.text, post.link);
  } catch {
    text = post.text;
  }
  return sanitizePublishedThreadsText(text);
}
const normalize = s =>
  String(s || '')
    .replace(/\s+/g, '')
    .toLowerCase();

// Picks the recent post that is this post: same text (whitespace-insensitive; a 60-char prefix match
// covers small server-side changes) and published no earlier than 2 minutes before the attempt.
function matchLivePost(items, { text, since, excludeIds = new Set() } = {}) {
  const want = normalize(text);
  if (!want) return null;
  const key = want.slice(0, 60);
  for (const item of items || []) {
    if (!item?.id || excludeIds.has(String(item.id))) continue;
    const at = Date.parse(String(item.timestamp || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    if (Number.isFinite(since) && Number.isFinite(at) && at < since - 120000) continue;
    const got = normalize(item.text);
    if (!got) continue;
    if (got === want || (key.length >= 10 && (got.startsWith(key) || want.startsWith(got.slice(0, 60)))))
      return item;
  }
  return null;
}

function markLive(post, account, item) {
  const now = new Date().toISOString();
  const postedAt = (() => {
    const at = Date.parse(String(item.timestamp || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return Number.isFinite(at) ? new Date(at).toISOString() : now;
  })();
  const comment = !!post.auto_comment_enabled && !!(post.link || post.recipe_comment_text) && !post.comment_media_id;
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db
      .prepare(
        "UPDATE posts SET status='posted',threads_media_id=?,threads_permalink=?,posted_at=?,error_message=NULL,publish_next_retry_at=NULL,publish_recovered_at=?,comment_status=?,comment_next_retry_at=?,comment_retry_count=0 WHERE id=? AND status IN ('failed','publishing') AND threads_media_id IS NULL"
      )
      .run(
        String(item.id),
        item.permalink ? String(item.permalink) : null,
        postedAt,
        now,
        comment ? 'pending' : post.comment_status || 'none',
        comment ? new Date(Date.now() + 60000).toISOString() : null,
        post.id
      );
    if (Number(res.changes)) {
      if (account.user_id) logUsage(account.user_id, 'publish');
      db.prepare(
        'INSERT INTO insights(post_id,views,likes,replies,reposts,quotes) VALUES(?,0,0,0,0,0) ON CONFLICT(post_id) DO NOTHING'
      ).run(post.id);
    }
    db.exec('COMMIT');
    return Number(res.changes) > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const clientError = err => {
  const status = Number(err?.response?.status || 0);
  return status >= 400 && status < 500 && status !== 429;
};

// Returns 'live' | 'requeued' | 'not_live' | 'review' | 'deferred' (transient error: try next tick).
async function reconcilePost(post) {
  const account = getAccount(post.account_id);
  if (!account?.threads_access_token) return 'deferred';
  let container = '';
  if (post.publish_creation_id && typeof api.getAccountContainerStatus === 'function') {
    try {
      container = String((await api.getAccountContainerStatus(post.account_id, post.publish_creation_id))?.status || '');
    } catch (err) {
      if (!clientError(err)) return 'deferred';
      container = 'GONE'; // expired/unknown container: it was never published by us
    }
  }
  let items;
  try {
    items = await api.listRecentThreads(post.account_id, { limit: 25 });
  } catch {
    return 'deferred';
  }
  const excludeIds = new Set(
    db
      .prepare('SELECT threads_media_id FROM posts WHERE account_id=? AND threads_media_id IS NOT NULL')
      .all(post.account_id)
      .map(r => String(r.threads_media_id))
  );
  const since = Date.parse(post.publish_started_at || post.scheduled_at);
  const match = matchLivePost(items, { text: post.sent_text || sentTextFor(post), since, excludeIds });
  const now = new Date().toISOString();
  if (match) {
    markLive(post, account, match);
    console.log(`[Publish][RECOVERY] post=${post.id} 라이브 확인 → posted mediaId=${match.id}`);
    return 'live';
  }
  const fail = message =>
    db
      .prepare("UPDATE posts SET error_message=?,publish_recovered_at=? WHERE id=? AND status='failed'")
      .run(message, now, post.id);
  if (container === 'PUBLISHED') {
    fail('PUBLISH_OUTCOME_UNKNOWN_REVIEW: 컨테이너는 발행됨, 최근 글에서 못 찾음 - 수동 확인 (자동 재발행 안 함)');
    console.warn(`[Publish][RECOVERY] post=${post.id} 컨테이너 PUBLISHED, 글 못 찾음 → 수동 확인`);
    return 'review';
  }
  if (container === 'ERROR') {
    fail('PUBLISH_NOT_LIVE: 라이브 아님 확인, 미디어 처리 오류라 자동 재시도 안 함');
    return 'not_live';
  }
  const age = Date.now() - Date.parse(post.scheduled_at);
  if (Number.isFinite(age) && age <= requeueWindowMs()) {
    db.prepare(
      "UPDATE posts SET status='pending',publish_next_retry_at=?,publish_started_at=NULL,publish_creation_id=NULL,publish_recovered_at=?,error_message='REQUEUED_NOT_LIVE: 라이브 아님 확인, 1회 재시도' WHERE id=? AND status='failed' AND threads_media_id IS NULL"
    ).run(new Date(Date.now() + 60000).toISOString(), now, post.id);
    console.warn(`[Publish][RECOVERY] post=${post.id} 라이브 아님 → 1회 재시도 대기`);
    return 'requeued';
  }
  fail('PUBLISH_NOT_LIVE: 라이브 아님 확인 (재시도 창 지남 - 재예약 필요)');
  console.warn(`[Publish][RECOVERY] post=${post.id} 라이브 아님, 재시도 창 지남 → 재예약 필요`);
  return 'not_live';
}

// Failed posts whose outcome is unknown (restart mid-publish, lost threads_publish response, a
// container whose status was unknown) plus legacy first-attempt ERR_CANCELED rows. Bounded per tick.
async function reconcileUnknownPublishes({ limit = RECOVERY_PER_TICK, shouldStop = () => false } = {}) {
  if (typeof api.listRecentThreads !== 'function') return [];
  const rows = db
    .prepare(
      "SELECT * FROM posts WHERE status='failed' AND threads_media_id IS NULL AND publish_recovered_at IS NULL AND scheduled_at>=? AND (error_message LIKE 'PUBLISH_OUTCOME_UNKNOWN:%' OR (error_message='ERR_CANCELED' AND COALESCE(publish_retry_count,0)<=1)) ORDER BY scheduled_at,id LIMIT ?"
    )
    .all(new Date(Date.now() - LOOKBACK_MS).toISOString(), limit);
  const results = [];
  for (const post of rows) {
    if (shouldStop()) break;
    try {
      results.push({ id: post.id, result: await reconcilePost(post) });
    } catch (err) {
      console.warn(`[Publish][RECOVERY ERROR] post=${post.id} ${String(err.message).slice(0, 160)}`);
      results.push({ id: post.id, result: 'deferred' });
    }
  }
  return results;
}

// Before re-sending a post that already created a container on an earlier attempt: if that container
// is PUBLISHED the post may be live, so it is not re-sent (the recovery pass then finds it).
// Returns true when sending is safe.
async function checkBeforeRetry(post) {
  if (!post.publish_creation_id || typeof api.getAccountContainerStatus !== 'function') return true;
  try {
    const info = await api.getAccountContainerStatus(post.account_id, post.publish_creation_id);
    if (String(info?.status || '').toUpperCase() !== 'PUBLISHED') return true;
    db.prepare(
      "UPDATE posts SET status='failed',error_message='PUBLISH_OUTCOME_UNKNOWN: 재시도 전 확인 - 이전 컨테이너가 이미 발행됨',publish_next_retry_at=NULL WHERE id=?"
    ).run(post.id);
    console.warn(`[Publish][RETRY CHECK] post=${post.id} 이전 컨테이너 PUBLISHED → 재발행 안 함`);
    return false;
  } catch (err) {
    if (clientError(err)) return true;
    db.prepare(
      "UPDATE posts SET status='pending',publish_started_at=NULL,publish_next_retry_at=? WHERE id=? AND status='publishing'"
    ).run(new Date(Date.now() + 5 * 60000).toISOString(), post.id);
    return false;
  }
}

module.exports = { reconcileUnknownPublishes, reconcilePost, checkBeforeRetry, matchLivePost, sentTextFor };
