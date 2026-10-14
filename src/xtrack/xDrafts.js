'use strict';
// Storage for X companion threads. One row per Threads post; the Threads row is never touched,
// so the existing Threads pipeline keeps working exactly as before even if this table breaks.
const { db } = require('../infra/db');

try {
  db.exec(
    `CREATE TABLE IF NOT EXISTS x_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL UNIQUE,
      account_id INTEGER NOT NULL,
      tweets_json TEXT NOT NULL,
      cta_target TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      x_post_ids TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT
    )`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_x_drafts_status ON x_drafts(status, created_at)`);
} catch (e) {
  console.error('[XTrack][DB] x_drafts 생성 실패 - Threads 파이프라인은 계속 동작합니다:', e.message);
}

function saveDraft({ postId, accountId, tweets, ctaTarget }) {
  return db
    .prepare(`INSERT OR IGNORE INTO x_drafts (post_id, account_id, tweets_json, cta_target) VALUES (?,?,?,?)`)
    .run(postId, accountId, JSON.stringify(tweets), ctaTarget || null).lastInsertRowid;
}

function listDrafts(accountId, limit = 50) {
  return db
    .prepare(
      `SELECT d.*, p.status AS threads_status, p.posted_at AS threads_posted_at
         FROM x_drafts d LEFT JOIN posts p ON p.id = d.post_id
        WHERE d.account_id=? ORDER BY d.id DESC LIMIT ?`
    )
    .all(accountId, limit)
    .map(r => ({ ...r, tweets: JSON.parse(r.tweets_json || '[]') }));
}

// Drafts whose Threads post already went out - X follows Threads, never the other way round.
function dueForPublish(limit = 3) {
  return db
    .prepare(
      `SELECT d.* FROM x_drafts d JOIN posts p ON p.id = d.post_id
        WHERE d.status='draft' AND p.status='posted' ORDER BY p.posted_at, d.id LIMIT ?`
    )
    .all(limit)
    .map(r => ({ ...r, tweets: JSON.parse(r.tweets_json || '[]') }));
}

function publishedCountSince(isoTime) {
  return db.prepare(`SELECT COUNT(*) AS n FROM x_drafts WHERE status='published' AND published_at>=?`).get(isoTime).n;
}

function markPublished(id, xPostIds) {
  db.prepare(`UPDATE x_drafts SET status='published', x_post_ids=?, published_at=?, error_message=NULL WHERE id=?`).run(
    JSON.stringify(xPostIds),
    new Date().toISOString(),
    id
  );
}

function markFailed(id, message, xPostIds = []) {
  db.prepare(`UPDATE x_drafts SET status='failed', error_message=?, x_post_ids=? WHERE id=?`).run(
    String(message || '').slice(0, 500),
    JSON.stringify(xPostIds),
    id
  );
}

function markCopied(id, accountId) {
  return db
    .prepare(`UPDATE x_drafts SET status='manual', published_at=? WHERE id=? AND account_id=? AND status='draft'`)
    .run(new Date().toISOString(), id, accountId).changes;
}

module.exports = { saveDraft, listDrafts, dueForPublish, publishedCountSince, markPublished, markFailed, markCopied };
