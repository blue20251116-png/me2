'use strict';
const path = require('path');

// Single source of truth for on-disk locations. Code lives in src/, but runtime data stays at
// <project root>/db so the existing Railway volume (mounted at /app/db) keeps working unchanged.
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.ME2_DATA_DIR ? path.resolve(process.env.ME2_DATA_DIR) : path.join(ROOT_DIR, 'db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'scheduler.db');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

module.exports = { ROOT_DIR, DATA_DIR, UPLOADS_DIR, DB_FILE, PUBLIC_DIR };
