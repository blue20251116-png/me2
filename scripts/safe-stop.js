'use strict';
// 2026-11-05 (marketing c1266546): stop the me2 server without cutting off a post that is being
// published. Windows Stop-Process/taskkill never deliver SIGTERM, so this asks the server to drain
// (creates <data dir>/shutdown.request), then waits until http://127.0.0.1:<PORT>/healthz stops
// answering. The server finishes the post in flight (bounded by ME2_SHUTDOWN_GRACE_MS, default 180s)
// and exits by itself. Start it again afterwards (start-company.ps1 -Ensure or start-local.ps1).
//   node scripts/safe-stop.js [--port 3000] [--timeout-sec 240]
// Exit code 0 = server stopped, 1 = still running after the timeout (nothing was killed).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { DATA_DIR } = require('../src/config/paths');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = Number(arg('--port', process.env.PORT || 3000));
const timeoutMs = Number(arg('--timeout-sec', 240)) * 1000;
const requestFile = path.join(DATA_DIR, 'shutdown.request');

const alive = () =>
  new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });

(async () => {
  if (!(await alive())) {
    console.log(`[safe-stop] nothing answers on port ${port} - already stopped`);
    process.exit(0);
  }
  fs.writeFileSync(requestFile, new Date().toISOString());
  console.log(`[safe-stop] drain requested (${requestFile}); waiting up to ${timeoutMs / 1000}s`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    if (!(await alive())) {
      console.log('[safe-stop] server stopped cleanly');
      process.exit(0);
    }
  }
  console.error('[safe-stop] server still running after the timeout - nothing was killed; check the server log');
  process.exit(1);
})();
