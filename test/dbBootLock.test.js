'use strict';
// REGRESSION (CI, 2026-09-30): with a fresh database file, a process booting db.js while another
// process held the DB failed "PRAGMA journal_mode=WAL" instantly - and because busy_timeout was set
// in the same batch after it, busy_timeout never applied and every later write in that process
// failed with "database is locked" instead of waiting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('db.js waits for a lock held by another process at boot instead of failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-lock-'));
  const holder = new DatabaseSync(path.join(dir, 'scheduler.db'));
  holder.exec('BEGIN EXCLUSIVE');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const m=require('./src/infra/db');
       m.db.prepare("INSERT INTO settings(key,value) VALUES('probe','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
       console.log('CHILD_WRITE_OK');`,
    ],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, ME2_DATA_DIR: dir, NODE_ENV: 'test' } }
  );
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  setTimeout(() => holder.exec('COMMIT'), 1000);
  const code = await new Promise(resolve => child.on('exit', resolve));
  holder.close();
  assert.equal(code, 0, out);
  assert.match(out, /CHILD_WRITE_OK/);
  assert.doesNotMatch(out, /database is locked/);
});
