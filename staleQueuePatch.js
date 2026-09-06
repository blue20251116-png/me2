const cron = require('node-cron');
const { db } = require('./db');

// 예정 시각을 조금 넘긴 새 글은 허용하되, 오래 밀린 최초 발행만 폐기한다.
// publishQueue가 명시적으로 재시도를 예약한 pending 글은 publish_next_retry_at까지 보존한다.
const STALE_MINUTES = Math.max(1, Number(process.env.STALE_PENDING_MINUTES || 5));

function expireStalePendingPosts() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const columns = db.prepare('PRAGMA table_info(posts)').all();
  const hasPublishRetry = columns.some(c => c.name === 'publish_next_retry_at');
  const rows = hasPublishRetry
    ? db.prepare(`SELECT id, account_id, scheduled_at, publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`).all()
    : db.prepare(`SELECT id, account_id, scheduled_at, NULL AS publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`).all();
  const affectedAccounts = new Set();
  let expired = 0;

  for (const post of rows) {
    // A queue-level retry is an intentional live job, not stale backlog. It must
    // be allowed to reach publishQueue even when the original schedule is old.
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
    console.log(`[Publish][STALE EXPIRE] account #${post.account_id} post #${post.id} late=${lateMin}m threshold=${STALE_MINUTES}m -> skip old post`);
  }

  for (const accountId of affectedAccounts) {
    const account = db.prepare(`SELECT id, autopilot_enabled, autopilot_next_at FROM accounts WHERE id=?`).get(accountId);
    if (!account?.autopilot_enabled) continue;

    const nextMs = account.autopilot_next_at ? new Date(account.autopilot_next_at).getTime() : NaN;
    if (!Number.isFinite(nextMs) || nextMs > nowMs) {
      db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(nowIso, accountId);
      console.log(`[Autopilot][FRESH RESTART] account #${accountId} stale queue expired -> nextAt=${nowIso}`);
    }
  }

  if (expired) console.log(`[Publish][STALE QUEUE] expired=${expired} threshold=${STALE_MINUTES}m retries=preserved comments=untouched`);
}

try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] startup cleanup failed:', e.message); }
cron.schedule('* * * * *', () => {
  try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] cleanup failed:', e.message); }
});

console.log(`[Publish][STALE QUEUE] 오래된 최초 미발행 ${STALE_MINUTES}분 초과 자동폐기 + 예약 재시도 보존 + 새소재 재시작 활성화`);

module.exports = { expireStalePendingPosts };
