'use strict';
/* global document */
// Browser smoke test for the dashboard UI: real app + real Chromium. Fails on any uncaught page
// JavaScript error, so a broken script include or a renamed API field shows up in CI.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE can point at a preinstalled Chromium; ME2_SKIP_BROWSER_TESTS=1
// skips (e.g. on a machine without browsers).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-ui-'));
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-only-session-secret';

const skip = process.env.ME2_SKIP_BROWSER_TESTS === '1' ? 'ME2_SKIP_BROWSER_TESTS=1' : false;

test(
  'public pages, admin login and the member dashboard render without JavaScript errors',
  { skip, timeout: 90000 },
  async () => {
    const { createApp } = require('../src/web/app');
    const { chromium } = require('playwright');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
      const setup = await fetch(`${base}/api/auth/setup-admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'admin-password-1' }),
      });
      assert.equal(setup.status, 200);

      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      for (const publicPage of ['/login.html', '/signup.html', '/status.html']) {
        assert.equal((await page.goto(base + publicPage)).status(), 200, publicPage);
      }

      const login = async (email, password, landing) => {
        await page.goto(`${base}/login.html`);
        await page.fill('input[name=email]', email);
        await page.fill('input[name=password]', password);
        await Promise.all([
          page.waitForURL(url => new URL(url).pathname === landing),
          page.click('button[type=submit]'),
        ]);
      };

      // Admin lands on the admin page.
      await login('admin@example.com', 'admin-password-1', '/admin');
      await page.waitForLoadState('networkidle');

      // Approve a member (signup creates their Threads account), then log in as them.
      const adminCookie = (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ');
      await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'member@example.com',
          password: 'member-password-1',
          name: 'm||THREADS:member_t',
        }),
      });
      const users = await (await fetch(`${base}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
      const member = users.find(u => u.email === 'member@example.com');
      await fetch(`${base}/api/admin/users/${member.id}/approve`, { method: 'POST', headers: { cookie: adminCookie } });
      await page.context().clearCookies();

      await login('member@example.com', 'member-password-1', '/');
      await page.waitForFunction(() =>
        document.querySelector('#myUserEmail')?.textContent.includes('member@example.com')
      );
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#statPending')?.textContent || ''));
      assert.match(await page.locator('#accountStrip').innerText(), /member_t/);
      assert.ok(await page.locator('script[src*="liveInsights.js"]').count(), 'live insights script is included');

      assert.deepEqual(pageErrors, [], `uncaught page errors:\n${pageErrors.join('\n')}`);
    } finally {
      // Always release the browser and the port, so a launch failure fails fast instead of hanging.
      if (browser) await browser.close().catch(() => {});
      server.closeAllConnections?.();
      server.close();
    }
  }
);
