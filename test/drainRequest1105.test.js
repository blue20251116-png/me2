'use strict';
// 2026-11-05 (marketing c1266546): on Windows a restart cannot send SIGTERM, so the server also drains
// and exits 0 when <data dir>/shutdown.request appears (scripts/safe-stop.js creates it).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a drain request file stops the server cleanly', { timeout: 40000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-drain-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ME2_DATA_DIR: dataDir, PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 25000);
    child.stdout.on('data', () => {
      if (out.includes('Threads 스케줄러 서버')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  fs.writeFileSync(path.join(dataDir, 'shutdown.request'), 'now');
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, out);
  assert.match(out, /\[Shutdown\] DRAIN_REQUEST received/);
  assert.match(out, /\[Shutdown\] done/);
  assert.equal(fs.existsSync(path.join(dataDir, 'shutdown.request')), false);
});
