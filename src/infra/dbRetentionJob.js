'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, DB_FILE, UPLOADS_DIR } = require('../config/paths');
const { startRetentionCleanup } = require('./dbRetention');

// Retention runs on its own maintenance connection to the same SQLite file, isolated from
// application queries. Started once from the app entry point.
function startDbRetention() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const maintenanceDb = new DatabaseSync(DB_FILE);
  maintenanceDb.exec('PRAGMA busy_timeout=5000;');
  const controller = startRetentionCleanup(maintenanceDb, { uploadsDir: UPLOADS_DIR });
  process.once('exit', () => {
    controller.stop();
    try { maintenanceDb.close(); } catch {}
  });
  return controller;
}

module.exports = { startDbRetention };
