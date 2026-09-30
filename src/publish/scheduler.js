'use strict';
// Background jobs for publishing: the publish queue tick, insights refresh, and stale-queue cleanup.
const cron = require('node-cron');
const { db, listAllAccountsForSystem } = require('../infra/db');
const { getMediaInsights } = require('../threads/threadsApi');
const { buildCommentText } = require('./commentText');
const { dayKeyKst, kstMidnight, addDay } = require('./slots');

function startPublishJob() {
  return require('./publishQueue').startPublishJob({ buildCommentText });
}
// Refreshes posts from yesterday+today in KST. It used to use server-local midnight (UTC on
// Railway = 09:00 KST), so a post stopped being refreshed at the next 09:00 KST at the latest -
// posts published 00:00-09:00 KST were never refreshed after that morning, and every post's view
// count froze within hours even though Threads keeps distributing a post for 1-2 days.
function startInsightsJob() {
  cron.schedule(
    '*/10 * * * *',
    async () => {
      const start = kstMidnight(addDay(dayKeyKst(), -1));
      for (const s of listAllAccountsForSystem()) {
        const posts = db
          .prepare(
            `SELECT * FROM posts WHERE account_id=? AND status='posted' AND posted_at>=? AND threads_media_id IS NOT NULL`
          )
          .all(s.id, start.toISOString());
        for (const p of posts) {
          try {
            const stats = await getMediaInsights(s.id, p.threads_media_id);
            db.prepare(
              `INSERT INTO insights (post_id,views,likes,replies,reposts,quotes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,updated_at=excluded.updated_at`
            ).run(
              p.id,
              stats.views || 0,
              stats.likes || 0,
              stats.replies || 0,
              stats.reposts || 0,
              stats.quotes || 0,
              new Date().toISOString()
            );
          } catch (e) {
            console.error(`[인사이트 갱신 실패] account #${s.id}:`, e.message);
          }
        }
      }
    },
    { noOverlap: true }
  );
}
// 예정 시각을 조금 넘긴 새 글은 허용하되, 오래 밀린 최초 발행만 폐기한다.
// publishQueue가 명시적으로 재시도를 예약한 pending 글은 publish_next_retry_at까지 보존한다.
// Default raised 5 -> 15 min (2026-09-30 audit): the publish tick handles due posts one at a time,
// and a single video/carousel (readiness polling + publish retries + ffmpeg re-encode) can hold
// it for several minutes - with a 5-min threshold, other accounts' posts queued behind it were
// discarded as "stale" before the tick ever reached them. 15 min still drops genuinely old work.
const STALE_MINUTES = Math.max(1, Number(process.env.STALE_PENDING_MINUTES || 15));
function expireStalePendingPosts() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const columns = db.prepare('PRAGMA table_info(posts)').all();
  const hasPublishRetry = columns.some(c => c.name === 'publish_next_retry_at');
  const rows = hasPublishRetry
    ? db
        .prepare(
          `SELECT id, account_id, scheduled_at, publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`
        )
        .all()
    : db
        .prepare(
          `SELECT id, account_id, scheduled_at, NULL AS publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`
        )
        .all();
  const affectedAccounts = new Set();
  let expired = 0;
  for (const post of rows) {
    if (post.publish_next_retry_at) continue;
    const scheduledMs = new Date(post.scheduled_at).getTime();
    if (!Number.isFinite(scheduledMs)) continue;
    const lateMs = nowMs - scheduledMs;
    if (lateMs < STALE_MINUTES * 60 * 1000) continue;
    const lateMin = Math.floor(lateMs / 60000);
    db.prepare(`UPDATE posts SET status='failed', error_message=? WHERE id=? AND status='pending'`).run(
      `STALE_EXPIRED: 예정시간보다 ${lateMin}분 지연되어 오래된 미발행 작업을 폐기했습니다. 밀린 글은 발행하지 않고 현재 시점부터 새 소재로 진행합니다.`,
      post.id
    );
    affectedAccounts.add(Number(post.account_id));
    expired++;
    console.log(
      `[Publish][STALE EXPIRE] account #${post.account_id} post #${post.id} late=${lateMin}m threshold=${STALE_MINUTES}m -> skip old post`
    );
  }
  for (const accountId of affectedAccounts) {
    const account = db
      .prepare(`SELECT id, autopilot_enabled, autopilot_next_at FROM accounts WHERE id=?`)
      .get(accountId);
    if (!account?.autopilot_enabled) continue;
    const nextMs = account.autopilot_next_at ? new Date(account.autopilot_next_at).getTime() : NaN;
    if (!Number.isFinite(nextMs) || nextMs > nowMs) {
      db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(nowIso, accountId);
      console.log(`[Autopilot][FRESH RESTART] account #${accountId} stale queue expired -> nextAt=${nowIso}`);
    }
  }
  if (expired)
    console.log(
      `[Publish][STALE QUEUE] expired=${expired} threshold=${STALE_MINUTES}m retries=preserved comments=untouched`
    );
}
function startStaleQueueJob() {
  try {
    expireStalePendingPosts();
  } catch (e) {
    console.warn('[Publish][STALE QUEUE] startup cleanup failed:', e.message);
  }
  cron.schedule(
    '* * * * *',
    () => {
      try {
        expireStalePendingPosts();
      } catch (e) {
        console.warn('[Publish][STALE QUEUE] cleanup failed:', e.message);
      }
    },
    { noOverlap: true }
  );
  console.log(
    `[Publish][STALE QUEUE] 오래된 최초 미발행 ${STALE_MINUTES}분 초과 자동폐기 + 예약 재시도 보존 + 새소재 재시작 활성화`
  );
}

module.exports = { startPublishJob, startInsightsJob, startStaleQueueJob, expireStalePendingPosts };
