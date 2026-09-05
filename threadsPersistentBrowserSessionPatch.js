'use strict';

const fs = require('fs');

if (!global.__ME2_THREADS_PERSISTENT_BROWSER_SESSION_PATCH__) {
  global.__ME2_THREADS_PERSISTENT_BROWSER_SESSION_PATCH__ = true;

  const playwright = require('playwright');
  const chromium = playwright.chromium;
  const originalLaunch = chromium.launch.bind(chromium);

  chromium.launch = async function persistentThreadsLaunch(options = {}) {
    const browser = await originalLaunch(options);
    const originalNewContext = browser.newContext.bind(browser);

    browser.newContext = async function persistentThreadsContext(contextOptions = {}) {
      // Explicit caller state always wins. Otherwise reuse the Railway persistent
      // Threads state. Cookies are domain-scoped, so unrelated browser targets do
      // not receive usable Threads credentials.
      if (contextOptions.storageState) return originalNewContext(contextOptions);

      const statePath = process.env.THREADS_STORAGE_STATE_PATH || '/app/db/threads-storage-state.json';
      try {
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (state && Array.isArray(state.cookies)) {
            console.log(`[Threads][SESSION BRIDGE] persistent state attached path=${statePath} cookies=${state.cookies.length}`);
            return originalNewContext({ ...contextOptions, storageState: state });
          }
        }
      } catch (err) {
        console.warn(`[Threads][SESSION BRIDGE] state attach failed: ${err.message}`);
      }
      return originalNewContext(contextOptions);
    };
    return browser;
  };

  console.log('[Threads][SESSION BRIDGE] Playwright contexts inherit persistent Threads storageState when available');
}
