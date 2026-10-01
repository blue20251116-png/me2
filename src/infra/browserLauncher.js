'use strict';

// Container-safe Chromium flags. Railway containers hit a process/thread ceiling (pthread_create
// EAGAIN, SIGTRAP on launch), so these minimise helper processes: GPU work in-process, one renderer,
// no zygote. --single-process was tried and reverted (it crashed on every launch).
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function mergeSafeArgs(args = []) {
  const incoming = (Array.isArray(args) ? args : []).filter(arg => arg !== '--single-process');
  return [...new Set([...incoming, ...SAFE_ARGS])];
}

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

// Every Chromium launch in this app goes through here (explicitly - no more hooking require()).
// Adds the container-safe flags above, serializes launches, and backs off after a launch crash.
async function launchChromium(options = {}) {
  const { chromium } = require('playwright');
  await acquireBrowserSlot();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseBrowserSlot();
    }
  };
  try {
    const browser = await chromium.launch({
      ...options,
      headless: options.headless !== false,
      args: mergeSafeArgs(options.args),
    });
    const originalClose = typeof browser.close === 'function' ? browser.close.bind(browser) : null;
    if (originalClose)
      browser.close = async (...args) => {
        try {
          return await originalClose(...args);
        } finally {
          release();
        }
      };
    if (typeof browser.once === 'function') browser.once('disconnected', release);
    return browser;
  } catch (err) {
    if (isLaunchCrash(err)) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + FAILURE_COOLDOWN_MS);
      console.error(`[Browser] Chromium launch crash detected; cooldown=${FAILURE_COOLDOWN_MS}ms`);
    }
    release();
    throw err;
  }
}

module.exports = { SAFE_ARGS, mergeSafeArgs, isLaunchCrash, launchChromium };
