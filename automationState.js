'use strict';
const { db } = require('./db');
// Same crash-at-boot class of bug found and fixed across db.js/bootstrap.js/server.js earlier
// (2026-09-12, the persistent-volume-full incident): this ran completely unguarded at module
// load, and this module is required very early in the boot chain (openAiBudgetGuardPatch.js,
// the 5th -r preload) - well before bootstrap.js/server.js. On a full disk this would crash the
// whole process here, before any of those other guards even get a chance to run.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS automation_state (
    account_id INTEGER PRIMARY KEY, status TEXT NOT NULL, detail TEXT,
    updated_at TEXT NOT NULL, retry_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_request_budget (at_ms INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_ai_request_budget_time ON ai_request_budget(at_ms);`);
} catch (e) {
  console.error('[AutomationState][INIT] 테이블 생성 실패 (디스크 문제로 추정) - 프로세스는 계속 부팅합니다:', e.message);
}

function setState(accountId, status, detail = '', retryAt = null) {
  db.prepare(`INSERT INTO automation_state VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
    status=excluded.status,detail=excluded.detail,updated_at=excluded.updated_at,retry_at=excluded.retry_at`)
    .run(accountId, status, detail, new Date().toISOString(), retryAt);
}
function budgetState(now = Date.now()) {
  const configured = Number(process.env.OPENAI_MAX_REQUESTS_PER_HOUR || 240);
  const limit = Number.isFinite(configured) ? Math.max(10, configured) : 240;
  db.prepare('DELETE FROM ai_request_budget WHERE at_ms<=?').run(now - 3600000);
  const row = db.prepare('SELECT COUNT(*) count,MIN(at_ms) oldest FROM ai_request_budget').get();
  return { used: Number(row.count), limit, available: Number(row.count) < limit,
    retryAt: Number(row.count) >= limit ? Number(row.oldest) + 3600001 : null };
}
function reserveRequest() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = budgetState();
    if (!state.available) {
      const err = new Error(`OPENAI_HOURLY_BUDGET_EXCEEDED: ${state.used}/${state.limit}`);
      Object.assign(err, { code:'OPENAI_HOURLY_BUDGET_EXCEEDED', __openAiNoRetry:true, retryAt:state.retryAt });
      throw err;
    }
    db.prepare('INSERT INTO ai_request_budget VALUES(?)').run(Date.now());
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
module.exports = { setState, budgetState, reserveRequest };
