'use strict';

// Maintenance is deliberately allowlisted: never add user/account/settings tables here.
const RETENTION_TABLES = Object.freeze(['invocation_logs', 'cache']);
const RETENTION_SECONDS = 3 * 24 * 60 * 60;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TIMESTAMP_CANDIDATES = Object.freeze([
  'created_at', 'createdAt', 'timestamp', 'created', 'updated_at', 'updatedAt',
  'expires_at', 'expiresAt', 'cached_at', 'cachedAt', 'time',
]);

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

function deleteExpiredRows(db, table, timestampColumn) {
  const tableSql = quoteIdentifier(table);
  const columnSql = quoteIdentifier(timestampColumn);
  // Handles normal SQLite datetime/ISO-8601 text and unix epoch seconds/milliseconds.
  const sql = `DELETE FROM ${tableSql}
    WHERE CASE
      WHEN typeof(${columnSql}) IN ('integer','real') AND ${columnSql} > 100000000000
        THEN datetime(${columnSql} / 1000, 'unixepoch')
      WHEN typeof(${columnSql}) IN ('integer','real')
        THEN datetime(${columnSql}, 'unixepoch')
      ELSE datetime(${columnSql})
    END < datetime('now', '-${RETENTION_SECONDS} seconds')`;
  return Number(db.prepare(sql).run().changes || 0);
}

function runRetentionCleanup(db, logger = console) {
  const result = { deleted: {}, vacuumed: false, skipped: [] };
  let totalDeleted = 0;

  for (const table of RETENTION_TABLES) {
    if (!tableExists(db, table)) {
      result.skipped.push({ table, reason: 'table_missing' });
      continue;
    }
    const timestampColumn = findTimestampColumn(tableColumns(db, table));
    if (!timestampColumn) {
      // Fail closed instead of guessing and risking non-expired data.
      result.skipped.push({ table, reason: 'timestamp_column_missing' });
      logger.warn?.(`[DB][RETENTION] ${table}: timestamp column not found; skipped`);
      continue;
    }
    const deleted = deleteExpiredRows(db, table, timestampColumn);
    result.deleted[table] = deleted;
    totalDeleted += deleted;
  }

  // VACUUM cannot run inside a transaction. Only run it when deletion actually
  // freed pages, avoiding an expensive full rewrite every six hours.
  if (totalDeleted > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    result.vacuumed = true;
  }

  logger.log?.(`[DB][RETENTION] complete deleted=${totalDeleted} vacuumed=${result.vacuumed}`);
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
  RETENTION_TABLES,
  RETENTION_SECONDS,
  runRetentionCleanup,
  startRetentionCleanup,
};
