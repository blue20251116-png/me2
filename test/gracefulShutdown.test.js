'use strict';
// The real server process must exit cleanly on SIGTERM (Railway redeploys) instead of being killed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('SIGTERM drains the server and exits with code 0', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-shutdown-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ME2_DATA_DIR: dataDir, PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    child.stdout.on('data', () => {
      if (out.includes('Threads 스케줄러 서버')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, out);
  assert.match(out, /\[Shutdown\] done/);
});
