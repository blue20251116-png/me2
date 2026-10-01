'use strict';
// Reference ("benchmark") Threads accounts the autopilot scans for source material. Admin-managed.
const { db } = require('../infra/db');

function normalizeUsername(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  try {
    if (/^https?:\/\//i.test(v)) {
      const u = new URL(v);
      const m = u.pathname.match(/^\/@?([^/]+)/);
      if (m) v = m[1];
    }
  } catch {}
  v = v.replace(/^@+/, '').split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9._]{1,64}$/.test(v) ? v : '';
}

function parseUsernames(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value || '');
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map(normalizeUsername)
        .filter(Boolean)
    ),
  ];
}

function listBenchmarkAccounts() {
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();
}
function addBenchmarkAccount(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('올바른 Threads 아이디를 입력해주세요.');
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username=?').get(username);
}
function addBenchmarkAccountsBulk(value) {
  const usernames = parseUsernames(value);
  if (!usernames.length) throw new Error('등록할 Threads 아이디가 없습니다.');
  const insert = db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');
  let added = 0,
    skipped = 0;
  for (const username of usernames) {
    const info = insert.run(username);
    if (Number(info?.changes || 0) > 0) added++;
    else skipped++;
  }
  return { added, skipped, total: usernames.length, accounts: listBenchmarkAccounts() };
}
function deleteBenchmarkAccount(id) {
  return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id=?').run(Number(id));
}

module.exports = {
  normalizeUsername,
  parseUsernames,
  listBenchmarkAccounts,
  addBenchmarkAccount,
  addBenchmarkAccountsBulk,
  deleteBenchmarkAccount,
};
