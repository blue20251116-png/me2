'use strict';
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const MAX_BROWSER_WORKERS = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY || 1));
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.PLAYWRIGHT_CIRCUIT_FAILURES || 2));
const FAILURE_WINDOW_MS = Math.max(10000, Number(process.env.PLAYWRIGHT_CIRCUIT_WINDOW_MS || 120000));
const CIRCUIT_COOLDOWN_MS = Math.max(30000, Number(process.env.PLAYWRIGHT_CIRCUIT_COOLDOWN_MS || 300000));
const WORKER_KILL_GRACE_MS = Math.max(250, Number(process.env.PLAYWRIGHT_WORKER_KILL_GRACE_MS || 1500));
// A worker slot must never be lost forever. If killWorkerTree ever fails to actually reap a
// child (container/PID-namespace edge case, process stuck past SIGKILL, etc.) the 'exit' event
// that normally releases the slot never fires, and every future browser task queues forever —
// this is what silently wedges the whole autopilot scheduler after long uptime. Two independent
// backstops below make that unrecoverable-forever state impossible: a bounded queue wait, and a
// stale-slot reaper that reclaims a slot no later than its own task timeout plus a grace period.
const SLOT_WAIT_TIMEOUT_MS = Math.max(30000, Number(process.env.PLAYWRIGHT_SLOT_WAIT_TIMEOUT_MS || 5 * 60000));
const SLOT_STALE_GRACE_MS = Math.max(5000, Number(process.env.PLAYWRIGHT_SLOT_STALE_GRACE_MS || 30000));
let activeBrowserWorkers = 0;
const browserWorkerWaiters = [];
const activeSlotDeadlines = [];
let browserFailureTimes = [];
let browserCircuitOpenUntil = 0;

function browserInfraFailure(err) {
  const msg = String(err?.message || err || '');
  return err?.code === 'BROWSER_TASK_TIMEOUT' || err?.code === 'BROWSER_CIRCUIT_OPEN' || /SIGTRAP|pthread_create|Resource temporarily unavailable|browserType\.launch|Target page, context or browser has been closed|Browser worker exited without a result/i.test(msg);
}
function pruneFailures(now = Date.now()) { browserFailureTimes = browserFailureTimes.filter(ts => now - ts <= FAILURE_WINDOW_MS); }
function recordBrowserFailure(err) {
  if (!browserInfraFailure(err) || err?.code === 'BROWSER_CIRCUIT_OPEN') return;
  const now = Date.now(); pruneFailures(now); browserFailureTimes.push(now);
  if (browserFailureTimes.length >= FAILURE_THRESHOLD) {
    browserCircuitOpenUntil = Math.max(browserCircuitOpenUntil, now + CIRCUIT_COOLDOWN_MS);
    console.error(`[Browser Circuit] OPEN failures=${browserFailureTimes.length} cooldown=${CIRCUIT_COOLDOWN_MS}ms reason=${String(err?.message || err).slice(0,180)}`);
  }
}
function getBrowserCircuitState() {
  const now = Date.now();
  return { open: browserCircuitOpenUntil > now, retryAfterMs: Math.max(0, browserCircuitOpenUntil - now), activeWorkers: activeBrowserWorkers };
}
function resetBrowserCircuitForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Browser circuit reset is test-only');
  browserFailureTimes = [];
  browserCircuitOpenUntil = 0;
}
function assertBrowserCircuitClosed() {
  const now = Date.now();
  if (browserCircuitOpenUntil > now) {
    const err = new Error(`Browser infrastructure temporarily unavailable; retry after ${browserCircuitOpenUntil - now}ms`);
    err.code = 'BROWSER_CIRCUIT_OPEN'; err.retryAfterMs = browserCircuitOpenUntil - now; throw err;
  }
  if (browserCircuitOpenUntil) { console.log('[Browser Circuit] HALF-OPEN · allowing one probe worker'); browserCircuitOpenUntil = 0; browserFailureTimes = []; }
}
function reapStaleSlots() {
  const now = Date.now();
  let reclaimed = 0;
  while (activeSlotDeadlines.length && now >= activeSlotDeadlines[0]) { activeSlotDeadlines.shift(); reclaimed++; }
  if (!reclaimed) return;
  activeBrowserWorkers = Math.max(0, activeBrowserWorkers - reclaimed);
  console.error(`[Browser Circuit] STALE SLOT reclaimed count=${reclaimed} — a worker never released its slot after its own timeout; forcing recovery so future tasks are not stuck forever`);
  for (let i = 0; i < reclaimed; i++) { const next = browserWorkerWaiters.shift(); if (next) next(); }
}
async function acquireBrowserWorker(timeoutMs) {
  assertBrowserCircuitClosed();
  reapStaleSlots();
  if (activeBrowserWorkers >= MAX_BROWSER_WORKERS) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const waitTimer = setTimeout(() => {
        if (settled) return; settled = true;
        const idx = browserWorkerWaiters.indexOf(waiter);
        if (idx !== -1) browserWorkerWaiters.splice(idx, 1);
        reject(Object.assign(new Error(`Timed out after ${SLOT_WAIT_TIMEOUT_MS}ms waiting for a browser worker slot`), { code: 'BROWSER_SLOT_WAIT_TIMEOUT' }));
      }, SLOT_WAIT_TIMEOUT_MS);
      const waiter = () => { if (settled) return; settled = true; clearTimeout(waitTimer); resolve(); };
      browserWorkerWaiters.push(waiter);
    });
    assertBrowserCircuitClosed();
  }
  activeBrowserWorkers += 1;
  const deadline = Date.now() + timeoutMs + SLOT_STALE_GRACE_MS;
  activeSlotDeadlines.push(deadline);
  activeSlotDeadlines.sort((a, b) => a - b);
  return deadline;
}
function releaseBrowserWorker(deadline) {
  activeBrowserWorkers = Math.max(0, activeBrowserWorkers - 1);
  if (deadline != null) { const idx = activeSlotDeadlines.indexOf(deadline); if (idx !== -1) activeSlotDeadlines.splice(idx, 1); }
  const next = browserWorkerWaiters.shift(); if (next) next();
}
function descendantsOf(rootPid) {
  if (process.platform !== 'linux') return [];
  const children=new Map();
  let entries=[]; try { entries=fs.readdirSync('/proc'); } catch { return []; }
  for(const entry of entries) { if(!/^\d+$/.test(entry))continue; try { const stat=fs.readFileSync(`/proc/${entry}/stat`,'utf8'); const parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]); if(!children.has(parent))children.set(parent,[]); children.get(parent).push(Number(entry)); }catch{} }
  const result=[]; function visit(pid){for(const child of children.get(pid)||[]){visit(child);result.push(child);}} visit(rootPid); return result;
}
function killWorkerTree(child, signal = 'SIGKILL') {
  if (!child?.pid) return;
  if (process.platform === 'win32') { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} return; }
  for (const pid of descendantsOf(child.pid)) { try { process.kill(pid, signal); } catch {} }
  try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
}
async function runWorker(workerFile, payload, timeoutMs) {
  const slotDeadline = await acquireBrowserWorker(timeoutMs);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(workerFile, [], { execArgv: [], detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ME2_BROWSER_WORKER: '1' } });
    } catch (err) { releaseBrowserWorker(slotDeadline); recordBrowserFailure(err); reject(err); return; }
    let result, failure, finished = false, slotReleased = false, settled = false, killTimer = null;
    function releaseSlot() { if (!slotReleased) { slotReleased = true; releaseBrowserWorker(slotDeadline); } }
    function stop() {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      killWorkerTree(child, 'SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => killWorkerTree(child, 'SIGKILL'), WORKER_KILL_GRACE_MS);
    }
    function fail(err) { if (settled) return; settled=true; clearTimeout(timer); if(killTimer)clearTimeout(killTimer); stop(); releaseSlot(); recordBrowserFailure(err); reject(err); }
    const timer = setTimeout(() => { failure = Object.assign(new Error(`Browser task exceeded ${timeoutMs}ms`), { code: 'BROWSER_TASK_TIMEOUT' }); stop(); }, timeoutMs);
    child.on('message', message => {
      if (failure || finished) return;
      if (message.ok) result = message.value; else failure = Object.assign(new Error(message.error?.message || 'Browser task failed'), { code: message.error?.code });
      finished = true;
      // Disconnect IPC first so a worker that has already closed Playwright can exit
      // naturally; stop() remains a bounded fallback for leaked Chromium children.
      try { if (child.connected) child.disconnect(); } catch {}
      stop();
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (settled) return; settled=true; clearTimeout(timer); if(killTimer)clearTimeout(killTimer); releaseSlot();
      if (!failure && !finished) failure = new Error(`Browser worker exited without a result (${code ?? signal})`);
      if (failure) { recordBrowserFailure(failure); reject(failure); } else resolve(result);
    });
    child.send(payload, err => { if (err && !settled) { failure = err; stop(); } });
  });
}
function isolatedBrowserTask(moduleName, method, args, timeoutMs = 120000) { return runWorker(path.join(__dirname, 'isolatedBrowserWorker.js'), { moduleName, method, args, accountId: Number(global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID || 0) }, timeoutMs); }
module.exports = { isolatedBrowserTask, runWorker, MAX_BROWSER_WORKERS, browserInfraFailure, getBrowserCircuitState, resetBrowserCircuitForTests, descendantsOf, killWorkerTree };
