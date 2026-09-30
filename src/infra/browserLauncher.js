'use strict';

const Module = require('module');

// Keep Railway/container flags minimal. --single-process forces Chromium into
// an atypical process model and was present on every observed SIGTRAP launch.
// The parent isolatedTask circuit breaker now owns service-wide crash control.
//
// 2026-09-10: production logs showed repeated `pthread_create: Resource
// temporarily unavailable (11)` (EAGAIN) with 2GB+ RAM available, pointing at
// a process/thread-count ceiling (container PID/ulimit), not memory — and the
// GPU process specifically crash-looped 6x before Chromium gave up entirely
// ("GPU process isn't usable. Goodbye"), which then cascaded into the
// isolatedTask circuit breaker blocking every other account for 5 minutes.
// --in-process-gpu folds GPU work into the browser process instead of
// spawning (and crash-looping) a separate one; --renderer-process-limit=1
// caps renderer process count directly. Both are standalone Chromium flags
// that don't touch --disable-features, so they can't silently cancel
// Playwright's own default feature disables the way appending another
// --disable-features=... value would. Deliberately not revisiting
// --single-process — that was already tried and reverted per the note above.
//
// REGRESSION (found live, 2026-09-22): the exact same SIGTRAP/pthread_create
// class of crash reappeared - now hitting essentially every account on every
// 10-minute prefill tick, cascading through the isolatedTask circuit breaker
// and blocking ALL new material generation account-wide (browser logs came
// back completely empty, meaning Chromium died before it could log anything -
// the same instant-death signature as the Sep 10 ulimit/PID-ceiling issue).
// The account count has grown substantially since Sep 10 (a dozen-plus
// distinct accounts now ticking in the same single Node process), so the same
// container-wide process/thread ceiling is plausibly being hit again even
// though concurrent Chromium launches were already serialized to 1 at a time
// by both this guard and isolatedTask.js's own MAX_BROWSER_WORKERS. Added
// --no-zygote: Chromium normally keeps one long-lived "zygote" helper process
// alive purely to fork() new renderer/GPU processes faster - a whole extra
// process plus its own thread pool that this app's use case (short-lived,
// serialized, single-page scraping tasks) gets no benefit from. --no-zygote
// makes Chromium fork+exec each child directly instead, trading a little
// per-launch speed for one fewer persistent process and its threads - a
// smaller, additive step below --single-process (already tried and reverted
// above) rather than a repeat of it.
const SAFE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--in-process-gpu',
  '--renderer-process-limit=1',
  '--no-zygote',
];
const MAX_BROWSER_CONCURRENCY = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY || 1));
const FAILURE_COOLDOWN_MS = Math.max(5000, Number(process.env.PLAYWRIGHT_FAILURE_COOLDOWN_MS || 30000));

let activeBrowsers = 0;
let cooldownUntil = 0;
const waiters = [];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function mergeSafeArgs(args = []) {
  const incoming = (Array.isArray(args) ? args : []).filter(arg => arg !== '--single-process');
  return [...new Set([...incoming, ...SAFE_ARGS])];
}

async function acquireBrowserSlot() {
  while (true) {
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) await sleep(remaining);
    if (activeBrowsers < MAX_BROWSER_CONCURRENCY) { activeBrowsers += 1; return; }
    await new Promise(resolve => waiters.push(resolve));
  }
}
function releaseBrowserSlot() {
  activeBrowsers = Math.max(0, activeBrowsers - 1);
  const next = waiters.shift();
  if (next) next();
}
function isLaunchCrash(err) {
  const msg = String(err?.message || err || '');
  return /SIGTRAP|Target page, context or browser has been closed|browserType\.launch/i.test(msg);
}

function patchPlaywright(exp) {
  if (!exp?.chromium || exp.chromium.__me2RailwayGuarded) return exp;
  const chromium = exp.chromium;
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async function guardedLaunch(options = {}) {
    await acquireBrowserSlot();
    let released = false;
    const release = () => { if (!released) { released = true; releaseBrowserSlot(); } };
    try {
      const launchOptions = { ...options, headless: options.headless !== false, args: mergeSafeArgs(options.args) };
      const browser = await originalLaunch(launchOptions);
      const originalClose = typeof browser.close === 'function' ? browser.close.bind(browser) : null;
      if (originalClose) browser.close = async (...args) => { try { return await originalClose(...args); } finally { release(); } };
      if (typeof browser.once === 'function') browser.once('disconnected', release);
      return browser;
    } catch (err) {
      if (isLaunchCrash(err)) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + FAILURE_COOLDOWN_MS);
        console.error(`[Railway Browser Guard] Chromium launch crash detected; workerCooldown=${FAILURE_COOLDOWN_MS}ms`);
      }
      release(); throw err;
    }
  };
  Object.defineProperty(chromium, '__me2RailwayGuarded', { value: true });
  console.log(`[Railway Browser Guard] Playwright Chromium guarded · concurrency=${MAX_BROWSER_CONCURRENCY} · safeArgs=${SAFE_ARGS.join(',')}`);
  return exp;
}

if (!global.__ME2_RAILWAY_BROWSER_GUARD__) {
  global.__ME2_RAILWAY_BROWSER_GUARD__ = true;
  const originalLoad = Module._load;
  Module._load = function railwayBrowserGuardLoad(request, parent, isMain) {
    const exp = originalLoad.apply(this, arguments);
    if (request === 'playwright' || request === 'playwright-core') return patchPlaywright(exp);
    return exp;
  };
}

module.exports = { SAFE_ARGS, mergeSafeArgs, isLaunchCrash };
