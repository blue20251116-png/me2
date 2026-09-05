'use strict';
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Browser work happens in separate Node processes, so launch protection must
// live in the long-running parent. Child-local cooldowns disappear with every
// worker process and cannot stop a service-wide Chromium crash storm.
const MAX_BROWSER_WORKERS = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY || 1));
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.PLAYWRIGHT_CIRCUIT_FAILURES || 2));
const FAILURE_WINDOW_MS = Math.max(10000, Number(process.env.PLAYWRIGHT_CIRCUIT_WINDOW_MS || 120000));
const CIRCUIT_COOLDOWN_MS = Math.max(30000, Number(process.env.PLAYWRIGHT_CIRCUIT_COOLDOWN_MS || 300000));
let activeBrowserWorkers = 0;
const browserWorkerWaiters = [];
let browserFailureTimes = [];
let browserCircuitOpenUntil = 0;

function browserInfraFailure(err) {
  const msg = String(err?.message || err || '');
  return err?.code === 'BROWSER_TASK_TIMEOUT' || /SIGTRAP|browserType\.launch|Target page, context or browser has been closed|Browser worker exited without a result/i.test(msg);
}
function pruneFailures(now = Date.now()) {
  browserFailureTimes = browserFailureTimes.filter(ts => now - ts <= FAILURE_WINDOW_MS);
}
function recordBrowserFailure(err) {
  if (!browserInfraFailure(err)) return;
  const now = Date.now();
  pruneFailures(now);
  browserFailureTimes.push(now);
  if (browserFailureTimes.length >= FAILURE_THRESHOLD) {
    browserCircuitOpenUntil = Math.max(browserCircuitOpenUntil, now + CIRCUIT_COOLDOWN_MS);
    console.error(`[Browser Circuit] OPEN failures=${browserFailureTimes.length} cooldown=${CIRCUIT_COOLDOWN_MS}ms reason=${String(err?.message || err).slice(0,180)}`);
  }
}
function assertBrowserCircuitClosed() {
  const now = Date.now();
  if (browserCircuitOpenUntil > now) {
    const err = new Error(`Browser infrastructure temporarily unavailable; retry after ${browserCircuitOpenUntil - now}ms`);
    err.code = 'BROWSER_CIRCUIT_OPEN';
    err.retryAfterMs = browserCircuitOpenUntil - now;
    throw err;
  }
  if (browserCircuitOpenUntil) {
    console.log('[Browser Circuit] HALF-OPEN · allowing one probe worker');
    browserCircuitOpenUntil = 0;
    browserFailureTimes = [];
  }
}

async function acquireBrowserWorker() {
  assertBrowserCircuitClosed();
  if (activeBrowserWorkers >= MAX_BROWSER_WORKERS) {
    await new Promise(resolve => browserWorkerWaiters.push(resolve));
    assertBrowserCircuitClosed();
  }
  activeBrowserWorkers += 1;
}

function releaseBrowserWorker() {
  activeBrowserWorkers = Math.max(0, activeBrowserWorkers - 1);
  const next = browserWorkerWaiters.shift();
  if (next) next();
}

function descendantsOf(rootPid) {
  if (process.platform !== 'linux') return [];
  const children=new Map();
  for(const entry of fs.readdirSync('/proc')) {
    if(!/^\d+$/.test(entry))continue;
    try {
      const stat=fs.readFileSync(`/proc/${entry}/stat`,'utf8');
      const parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
      if(!children.has(parent))children.set(parent,[]);
      children.get(parent).push(Number(entry));
    }catch{}
  }
  const result=[];
  function visit(pid){for(const child of children.get(pid)||[]){visit(child);result.push(child);}}
  visit(rootPid);
  return result;
}

async function runWorker(workerFile, payload, timeoutMs) {
  await acquireBrowserWorker();
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [], {
      execArgv: [], detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ME2_BROWSER_WORKER: '1' },
    });
    let result, failure, finished = false, slotReleased = false;
    function releaseSlot() { if (!slotReleased) { slotReleased = true; releaseBrowserWorker(); } }
    function stop() {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else {
        for(const pid of descendantsOf(child.pid)) { try { process.kill(-pid,'SIGKILL'); } catch {} try { process.kill(pid,'SIGKILL'); } catch {} }
        try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    }
    const timer = setTimeout(() => { failure = Object.assign(new Error(`Browser task exceeded ${timeoutMs}ms`), { code: 'BROWSER_TASK_TIMEOUT' }); stop(); }, timeoutMs);
    child.on('message', message => {
      if (failure || finished) return;
      if (message.ok) result = message.value;
      else failure = Object.assign(new Error(message.error?.message || 'Browser task failed'), { code: message.error?.code });
      finished = true; stop();
    });
    child.once('error', err => { failure = err; clearTimeout(timer); recordBrowserFailure(err); releaseSlot(); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); stop(); releaseSlot();
      if (!failure && !finished) failure = new Error(`Browser worker exited without a result (${code ?? signal})`);
      if (failure) { recordBrowserFailure(failure); reject(failure); }
      else resolve(result);
    });
    child.send(payload, err => { if (err) { failure = err; stop(); } });
  });
}

function isolatedBrowserTask(moduleName, method, args, timeoutMs = 120000) {
  return runWorker(path.join(__dirname, 'isolatedBrowserWorker.js'), { moduleName, method, args, accountId: Number(global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID || 0) }, timeoutMs);
}
module.exports = { isolatedBrowserTask, runWorker, MAX_BROWSER_WORKERS, browserInfraFailure };
