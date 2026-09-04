'use strict';

const Module = require('module');
const path = require('path');

const SAFE_ARGS = [
  '--single-process',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];
const MAX_BROWSER_CONCURRENCY = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY || 1));
const FAILURE_COOLDOWN_MS = Math.max(5000, Number(process.env.PLAYWRIGHT_FAILURE_COOLDOWN_MS || 30000));

let activeBrowsers = 0;
let cooldownUntil = 0;
const waiters = [];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function mergeSafeArgs(args = []) { return [...new Set([...(Array.isArray(args) ? args : []), ...SAFE_ARGS])]; }

async function acquireBrowserSlot() {
  while (true) {
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) await sleep(remaining);
    if (activeBrowsers < MAX_BROWSER_CONCURRENCY) {
      activeBrowsers += 1;
      return;
    }
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
    const release = () => {
      if (released) return;
      released = true;
      releaseBrowserSlot();
    };
    try {
      const launchOptions = {
        ...options,
        headless: options.headless !== false,
        args: mergeSafeArgs(options.args),
      };
      const browser = await originalLaunch(launchOptions);
      const originalClose = typeof browser.close === 'function' ? browser.close.bind(browser) : null;
      if (originalClose) {
        browser.close = async (...args) => {
          try { return await originalClose(...args); }
          finally { release(); }
        };
      }
      if (typeof browser.once === 'function') browser.once('disconnected', release);
      return browser;
    } catch (err) {
      if (isLaunchCrash(err)) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + FAILURE_COOLDOWN_MS);
        console.error(`[Railway Browser Guard] Chromium launch crash detected; cooldown=${FAILURE_COOLDOWN_MS}ms`);
      }
      release();
      throw err;
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

  // Account #15 has a known invalid Coupang signature. Prevent recurring API
  // preflight noise and wasted work until its credentials are corrected.
  const previousCompile = Module.prototype._compile;
  Module.prototype._compile = function railwayBrowserGuardCompile(content, filename) {
    let source = String(content || '');
    if (path.basename(filename) === 'autopilotTimedPrefillPatch.js') {
      const marker = 'async function ensureCoupangReady(accountId, account) {\n';
      if (source.includes(marker) && !source.includes('ME2_ACCOUNT_15_QUARANTINED')) {
        source = source.replace(marker, `${marker}  if (Number(accountId) === 15) {\n    console.warn('[Autopilot][COUPANG PREFLIGHT] account #15 quarantined: known invalid signature');\n    setState(accountId, 'blocked', 'ME2_ACCOUNT_15_QUARANTINED');\n    return false;\n  }\n`);
        console.log('[Railway Browser Guard] account #15 Coupang quarantine ON');
      }
    }
    return previousCompile.call(this, source, filename);
  };
}

module.exports = {
  SAFE_ARGS,
  mergeSafeArgs,
  isLaunchCrash,
};
