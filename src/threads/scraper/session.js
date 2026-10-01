'use strict';
// Browser session for the Threads scraper: a Chromium context that restores and persists the
// logged-in storage state, plus small helpers shared by the collectors.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../config/paths');
const { launchChromium } = require('../../infra/browserLauncher');

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function openBrowser() {
  const browser = await launchChromium({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const statePath = process.env.THREADS_STORAGE_STATE_PATH || path.join(DATA_DIR, 'threads-storage-state.json');
  let storageState = null;
  try {
    if (fs.existsSync(statePath)) storageState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    else if (process.env.THREADS_STORAGE_STATE_JSON) {
      storageState = JSON.parse(process.env.THREADS_STORAGE_STATE_JSON);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(storageState), { mode: 0o600 });
    }
  } catch (e) {
    console.error('[Threads][SESSION] storageState load failed:', e.message);
    storageState = null;
  }
  const context = await browser.newContext({
    locale: 'ko-KR',
    viewport: { width: 1100, height: 1500 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    ...(storageState ? { storageState } : {}),
  });
  context.__threadsStatePath = statePath;
  context.__threadsStateHealthy = false;
  const originalClose = context.close.bind(context);
  context.close = async () => {
    if (context.__threadsStateHealthy) {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        await context.storageState({ path: statePath });
        try {
          fs.chmodSync(statePath, 0o600);
        } catch {}
        console.log('[Threads][SESSION] healthy state persisted');
      } catch (e) {
        console.error('[Threads][SESSION] storageState save failed:', e.message);
      }
    } else console.warn('[Threads][SESSION] challenged/unverified context · existing persistent state preserved');
    return originalClose();
  };
  console.log(`[Threads][SESSION] collector session=${storageState ? 'RESTORED' : 'ANONYMOUS'} path=${statePath}`);
  return { browser, context };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

module.exports = { shuffle, openBrowser, mapWithConcurrency };
