const cron = require('node-cron');
const { db } = require('./db');

// 예정 시각을 조금 넘긴 글은 허용하되, 오래 밀린 글이 현재 발행을 막지 않도록 빠르게 폐기한다.
// 기본 5분. Railway 환경변수 STALE_PENDING_MINUTES로 조정 가능하며 최소 1분까지 허용한다.
const STALE_MINUTES = Math.max(1, Number(process.env.STALE_PENDING_MINUTES || 5));

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

    // 밀린 글을 폐기한 뒤 자동화가 미래 시각에 묶여 있으면 현재 시각으로 당긴다.
    const nextMs = account.autopilot_next_at ? new Date(account.autopilot_next_at).getTime() : NaN;
    if (!Number.isFinite(nextMs) || nextMs > nowMs) {
      db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(nowIso, accountId);
      console.log(`[Autopilot][FRESH RESTART] account #${accountId} stale queue expired -> nextAt=${nowIso}`);
    }
  }

  if (expired) console.log(`[Publish][STALE QUEUE] expired=${expired} threshold=${STALE_MINUTES}m comments=untouched`);
}

// 서버 시작 시 밀린 pending을 즉시 정리하고, 이후 매분 확인한다.
try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] startup cleanup failed:', e.message); }
cron.schedule('* * * * *', () => {
  try { expireStalePendingPosts(); } catch (e) { console.warn('[Publish][STALE QUEUE] cleanup failed:', e.message); }
});

console.log(`[Publish][STALE QUEUE] 오래된 미발행 ${STALE_MINUTES}분 초과 자동폐기 + 새소재 재시작 활성화 · posted/comment queue untouched`);
