const cron = require('node-cron');
const { db } = require('./db');

const STALE_MINUTES = Math.max(15, Number(process.env.STALE_PENDING_MINUTES || 45));

function expireStalePendingPosts() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const rows = db.prepare(`SELECT id, account_id, scheduled_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`).all();
  const affectedAccounts = new Set();
  let expired = 0;

  for (const post of rows) {
    const scheduledMs = new Date(post.scheduled_at).getTime();
    if (!Number.isFinite(scheduledMs)) continue;
    const lateMs = nowMs - scheduledMs;
    if (lateMs < STALE_MINUTES * 60 * 1000) continue;

    const lateMin = Math.floor(lateMs / 60000);
    db.prepare(`UPDATE posts SET status='failed', error_message=? WHERE id=? AND status='pending'`).run(
      `STALE_EXPIRED: 예정시간보다 ${lateMin}분 지연되어 오래된 미발행 작업을 폐기했습니다. 새 소재로 다시 시작합니다.`,
      post.id
    );
    affectedAccounts.add(Number(post.account_id));
    expired++;
    console.log(`[Publish][STALE EXPIRE] account #${post.account_id} post #${post.id} late=${lateMin}m threshold=${STALE_MINUTES}m -> skip old post`);
  }

  for (const accountId of affectedAccounts) {
    const account = db.prepare(`SELECT id, autopilot_enabled, autopilot_next_at FROM accounts WHERE id=?`).get(accountId);
    if (!account?.autopilot_enabled) continue;

    // 이미 더 이른 실행이 잡혀 있지 않다면 다음 오토파일럿 실행을 현재 시각으로 당긴다.
    const nextMs = account.autopilot_next_at ? new Date(account.autopilot_next_at).getTime() : NaN;
    if (!Number.isFinite(nextMs) || nextMs > nowMs) {
      db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(nowIso, accountId);
      console.log(`[Autopilot][FRESH RESTART] account #${accountId} stale queue expired -> nextAt=${nowIso}`);
    }
  }

  if (expired) console.log(`[Publish][STALE QUEUE] expired=${expired} threshold=${STALE_MINUTES}m comments=untouched`);
}

// 서버 시작 시 기존에 밀린 큐를 먼저 정리하고 이후 매분 한 번씩 확인한다.
try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] startup cleanup failed:', e.message); }
cron.schedule('* * * * *', () => {
  try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] cleanup failed:', e.message); }
});

console.log(`[Publish][STALE QUEUE] 오래된 미발행 ${STALE_MINUTES}분 초과 자동폐기 + 새소재 재시작 활성화 · posted/comment queue untouched`);
