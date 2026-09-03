'use strict';
const { db } = require('./db');
db.exec(`CREATE TABLE IF NOT EXISTS automation_state (
  account_id INTEGER PRIMARY KEY, status TEXT NOT NULL, detail TEXT,
  updated_at TEXT NOT NULL, retry_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_request_budget (at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ai_request_budget_time ON ai_request_budget(at_ms);`);

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
