'use strict';

// DB retention must never touch user/account/settings/credential tables.
// Keep policies explicit so adding a table requires an intentional decision.
const RETENTION_SECONDS = 3 * 24 * 60 * 60;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TIMESTAMP_CANDIDATES = Object.freeze([
  'created_at', 'createdAt', 'timestamp', 'created', 'updated_at', 'updatedAt',
  'expires_at', 'expiresAt', 'cached_at', 'cachedAt', 'time',
]);

const SIMPLE_RETENTION = Object.freeze({
  invocation_logs: RETENTION_SECONDS,
  cache: RETENTION_SECONDS,
  // Minute-level insight snapshots grow quickly and are only useful for recent diagnostics.
  insight_history: 7 * 24 * 60 * 60,
  // Publish quota only reads today's usage. Keep a month for operational audits.
  usage_events: 30 * 24 * 60 * 60,
});

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name));
}

function findTimestampColumn(columns) {
  return TIMESTAMP_CANDIDATES.find((candidate) => columns.includes(candidate)) || null;
}

function deleteExpiredRows(db, table, timestampColumn, retentionSeconds) {
  const tableSql = quoteIdentifier(table);
  const columnSql = quoteIdentifier(timestampColumn);
  const seconds = Math.max(60, Number(retentionSeconds || RETENTION_SECONDS));
  const sql = `DELETE FROM ${tableSql}
    WHERE CASE
      WHEN typeof(${columnSql}) IN ('integer','real') AND ${columnSql} > 100000000000
        THEN datetime(${columnSql} / 1000, 'unixepoch')
      WHEN typeof(${columnSql}) IN ('integer','real')
        THEN datetime(${columnSql}, 'unixepoch')
      ELSE datetime(${columnSql})
    END < datetime('now', '-${seconds} seconds')`;
  return Number(db.prepare(sql).run().changes || 0);
}

function deleteOldFailedPosts(db) {
  if (!tableExists(db, 'posts')) return { deleted: 0, skipped: 'table_missing' };
  const columns = tableColumns(db, 'posts');
  if (!columns.includes('status') || !columns.includes('created_at')) return { deleted: 0, skipped: 'columns_missing' };

  // Only terminal failures are disposable. Never delete pending/posted posts here.
  const ids = db.prepare(`SELECT id FROM posts
    WHERE status='failed' AND datetime(created_at) < datetime('now', '-${RETENTION_SECONDS} seconds')`).all().map(r => Number(r.id));
  if (!ids.length) return { deleted: 0 };

  const delInsight = tableExists(db, 'insights') ? db.prepare('DELETE FROM insights WHERE post_id=?') : null;
  const delHistory = tableExists(db, 'insight_history') ? db.prepare('DELETE FROM insight_history WHERE post_id=?') : null;
  const delPost = db.prepare("DELETE FROM posts WHERE id=? AND status='failed'");
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      delInsight?.run(id);
      delHistory?.run(id);
      deleted += Number(delPost.run(id).changes || 0);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { deleted };
}

function runRetentionCleanup(db, logger = console) {
  const result = { deleted: {}, vacuumed: false, skipped: [] };
  let totalDeleted = 0;

  for (const [table, retentionSeconds] of Object.entries(SIMPLE_RETENTION)) {
    if (!tableExists(db, table)) {
      result.skipped.push({ table, reason: 'table_missing' });
      continue;
    }
    const timestampColumn = findTimestampColumn(tableColumns(db, table));
    if (!timestampColumn) {
      result.skipped.push({ table, reason: 'timestamp_column_missing' });
      logger.warn?.(`[DB][RETENTION] ${table}: timestamp column not found; skipped`);
      continue;
    }
    const deleted = deleteExpiredRows(db, table, timestampColumn, retentionSeconds);
    result.deleted[table] = deleted;
    totalDeleted += deleted;
  }

  const failedPosts = deleteOldFailedPosts(db);
  if (failedPosts.skipped) result.skipped.push({ table: 'posts:failed', reason: failedPosts.skipped });
  else {
    result.deleted.failed_posts = failedPosts.deleted;
    totalDeleted += failedPosts.deleted;
  }

  // Reclaim WAL and database pages only when rows were actually removed.
  if (totalDeleted > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    result.vacuumed = true;
  }

  logger.log?.(`[DB][RETENTION] complete deleted=${totalDeleted} details=${JSON.stringify(result.deleted)} vacuumed=${result.vacuumed}`);
  return result;
}

function startRetentionCleanup(db, options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(60_000, Number(options.intervalMs || process.env.DB_RETENTION_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  let running = false;

  const run = () => {
    if (running) return null;
    running = true;
    try {
      return runRetentionCleanup(db, logger);
    } catch (error) {
      logger.error?.('[DB][RETENTION] cleanup failed:', error);
      return null;
    } finally {
      running = false;
    }
  };

  // Startup cleanup plus periodic cleanup while the server process remains up.
  setImmediate(run);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { run, stop: () => clearInterval(timer), intervalMs };
}

module.exports = {
  RETENTION_TABLES: Object.freeze(Object.keys(SIMPLE_RETENTION)),
  RETENTION_SECONDS,
  runRetentionCleanup,
  startRetentionCleanup,
};
