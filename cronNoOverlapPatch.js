// Prevent the same cron callback from running again while its previous run is still active.
// This is intentionally global and minimal: existing cron expressions and job logic stay unchanged.
const cron = require('node-cron');

if (!cron.__me2NoOverlapPatched) {
  const originalSchedule = cron.schedule.bind(cron);
  cron.schedule = function patchedSchedule(expression, func, options = {}) {
    return originalSchedule(expression, func, { ...options, noOverlap: true });
  };
  cron.__me2NoOverlapPatched = true;
  console.log('[Cron][NO_OVERLAP] 중복 실행 방지 활성화');
}
