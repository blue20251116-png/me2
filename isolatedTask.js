'use strict';
const { fork, spawn } = require('node:child_process');
const path = require('node:path');

// Wait for OS exit before releasing the caller. A timed-out browser cannot keep
// holding the shared scheduler lock or later return a stale result.
function runWorker(workerFile, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [], {
      execArgv: [], detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ME2_BROWSER_WORKER: '1' },
    });
    let result, failure, finished = false;
    function stop() {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (err) {
          if (err.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    }
    const timer = setTimeout(() => {
      failure = Object.assign(new Error(`Browser task exceeded ${timeoutMs}ms`), { code: 'BROWSER_TASK_TIMEOUT' });
      stop();
    }, timeoutMs);
    child.on('message', message => {
      if (failure || finished) return;
      if (message.ok) result = message.value;
      else failure = Object.assign(new Error(message.error?.message || 'Browser task failed'), { code: message.error?.code });
      finished = true;
      stop(); // Includes Chromium descendants even when browser.close() failed.
    });
    child.once('error', err => { failure = err; clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      stop();
      if (failure) reject(failure);
      else if (finished) resolve(result);
      else reject(new Error(`Browser worker exited without a result (${code ?? signal})`));
    });
    child.send(payload, err => { if (err) { failure = err; stop(); } });
  });
}

function isolatedBrowserTask(moduleName, method, args, timeoutMs = 120000) {
  return runWorker(path.join(__dirname, 'isolatedBrowserWorker.js'), {
    moduleName, method, args,
    accountId: Number(global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID || 0),
  }, timeoutMs);
}
module.exports = { isolatedBrowserTask, runWorker };
