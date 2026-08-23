'use strict';

// One-time cleanup for the broken reservation generation.
// Deletes only pending reservations, keeps posted/failed/history untouched,
// and records a persistent SQLite flag so future restarts do not clear again.
// node:sqlite DatabaseSync has no better-sqlite3 style db.transaction(),
// so use an explicit SQLite transaction.

const { db } = require('./db');

const FLAG = 'clear_pending_reservations_20260823_v1';

try {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_flags (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const done = db.prepare(`SELECT key FROM maintenance_flags WHERE key=?`).get(FLAG);
  if (done) {
    console.log(`[Maintenance][PENDING RESET] already applied flag=${FLAG}`);
  } else {
    const before = Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE status='pending'`).get()?.c || 0);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`DELETE FROM posts WHERE status='pending'`).run();
      db.prepare(`INSERT INTO maintenance_flags (key,applied_at) VALUES (?,?)`).run(FLAG,new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    console.log(`[Maintenance][PENDING RESET] one-time cleanup complete deleted=${before} flag=${FLAG}`);
  }
} catch (err) {
  console.error(`[Maintenance][PENDING RESET] failed reason="${err.message}"`);
  throw err;
}
