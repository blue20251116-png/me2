'use strict';
const { DATA_DIR } = require('../config/paths');

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { startRetentionCleanup } = require('./dbRetention');

// Use a dedicated maintenance connection to the same SQLite file. This keeps
// retention isolated from application queries and, importantly, does not
// import or mutate users/settings/account code paths.
const dbDir = DATA_DIR;
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const maintenanceDb = new DatabaseSync(path.join(dbDir, 'scheduler.db'));
maintenanceDb.exec('PRAGMA busy_timeout=5000;');

const controller = startRetentionCleanup(maintenanceDb, { uploadsDir: path.join(dbDir, 'uploads') });

function shutdown() {
  controller.stop();
  try { maintenanceDb.close(); } catch {}
}

process.once('exit', shutdown);
