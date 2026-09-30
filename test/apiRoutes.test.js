'use strict';
// End-to-end API tests: the real Express app (createApp) on a throwaway data directory, driven
// over HTTP with per-user cookie jars. No external services are called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-api-'));
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-only-session-secret';
delete process.env.THREADS_APP_ID;

const { createApp } = require('../src/web/app');
const { db, getAccount } = require('../src/infra/db');

let server;
let base;
test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
}

const admin = client();
const alice = client();
const bob = client();
const anon = client();
const ids = {};

test('health check and crawler blocking work without a session', async () => {
  assert.equal((await anon('GET', '/healthz')).status, 200);
  assert.equal((await anon('GET', '/login.html', null, { 'user-agent': 'facebookexternalhit/1.1' })).status, 404);
});

test('first admin setup works once, then is locked', async () => {
  assert.equal((await anon('GET', '/api/auth/admin-setup-status')).json.needsSetup, true);
  const r = await admin('POST', '/api/auth/setup-admin', { email: 'Admin@Example.com', password: 'admin-password-1' });
  assert.equal(r.status, 200);
  assert.equal(
    (await anon('POST', '/api/auth/setup-admin', { email: 'x@y.z', password: 'another-pass-1' })).status,
    409
  );
  assert.equal((await admin('GET', '/api/auth/me')).json.email, 'admin@example.com');
});

test('signup stays pending until an admin approves it', async () => {
  for (const [who, email] of [
    [alice, 'Alice@Example.com'],
    [bob, 'bob@example.com'],
  ]) {
    const name = `${email.split('@')[0]}||PLAN:basic||THREADS:${email.split('@')[0].toLowerCase()}_threads`;
    assert.equal((await who('POST', '/api/auth/signup', { email, password: 'user-password-1', name })).status, 200);
  }
  // A Threads id is required, and an email can only register once (case-insensitive).
  assert.equal(
    (await anon('POST', '/api/auth/signup', { email: 'c@example.com', password: 'x', name: 'c' })).status,
    400
  );
  assert.equal(
    (await anon('POST', '/api/auth/signup', { email: 'ALICE@example.com', password: 'x', name: 'a||THREADS:a' }))
      .status,
    400
  );
  const pending = await alice('POST', '/api/auth/login', { email: 'alice@example.com', password: 'user-password-1' });
  assert.equal(pending.status, 403);

  const users = (await admin('GET', '/api/admin/users')).json;
  assert.ok(
    users.every(u => u.password_hash === undefined),
    'password hashes are never returned'
  );
  for (const u of users.filter(u => u.role !== 'admin')) {
    assert.equal((await admin('POST', `/api/admin/users/${u.id}/approve`)).status, 200);
  }
  // Email is matched case-insensitively.
  assert.equal(
    (await alice('POST', '/api/auth/login', { email: 'ALICE@example.com', password: 'user-password-1' })).status,
    200
  );
  assert.equal(
    (await bob('POST', '/api/auth/login', { email: 'bob@example.com', password: 'user-password-1' })).status,
    200
  );
  assert.equal((await bob('POST', '/api/auth/login', { email: 'bob@example.com', password: 'wrong' })).status, 401);
});

test('protected APIs require login, admin APIs require the admin role', async () => {
  assert.equal((await anon('GET', '/api/accounts')).status, 401);
  assert.equal((await anon('GET', '/')).status, 302);
  assert.equal((await alice('GET', '/api/admin/users')).status, 403);
  assert.equal((await alice('GET', '/api/admin/system-api-settings')).status, 403);
  assert.equal((await admin('GET', '/api/admin/automation-health')).status, 200);
});

test('accounts are per-user: another user cannot read or change them', async () => {
  // Signup created one account per user (the Threads id given at signup).
  const aliceAccounts = (await alice('GET', '/api/accounts')).json;
  const bobAccounts = (await bob('GET', '/api/accounts')).json;
  assert.deepEqual(
    aliceAccounts.map(a => a.label),
    ['alice_threads']
  );
  ids.alice = aliceAccounts[0].id;
  ids.bob = bobAccounts[0].id;
  // Basic plan allows one account.
  assert.equal((await alice('POST', '/api/accounts', { label: '두번째' })).status, 400);
  for (const [method, url] of [
    ['GET', `/api/accounts/${ids.bob}/settings`],
    ['POST', `/api/accounts/${ids.bob}/settings`],
    ['DELETE', `/api/accounts/${ids.bob}`],
    ['GET', `/api/dashboard?accountId=${ids.bob}`],
    ['GET', `/api/posts?accountId=${ids.bob}`],
    ['GET', `/auth/login?accountId=${ids.bob}`],
  ]) {
    assert.equal((await alice(method, url, method === 'POST' ? {} : null)).status, 403, `${method} ${url}`);
  }
});

test('account settings store secrets encrypted and never return them', async () => {
  const r = await alice('POST', `/api/accounts/${ids.alice}/settings`, {
    THREADS_APP_ID: '123',
    THREADS_REDIRECT_URI: 'https://example.test/auth/callback',
    THREADS_APP_SECRET: 'threads-secret-value',
    COUPANG_ACCESS_KEY: 'cp-access',
    COUPANG_SECRET_KEY: 'cp-secret-value',
  });
  assert.equal(r.status, 200);
  const settings = await alice('GET', `/api/accounts/${ids.alice}/settings`);
  assert.equal(settings.json.hasThreadsSecret, true);
  assert.equal(settings.json.hasCoupangSecret, true);
  assert.ok(!settings.text.includes('threads-secret-value') && !settings.text.includes('cp-secret-value'));
  const raw = db.prepare('SELECT threads_app_secret, coupang_secret_key FROM accounts WHERE id=?').get(ids.alice);
  assert.match(raw.threads_app_secret, /^enc:v1:/);
  assert.match(raw.coupang_secret_key, /^enc:v1:/);
  assert.equal(getAccount(ids.alice).coupang_secret_key, 'cp-secret-value');
});

test('the admin system API settings endpoint only reports whether secrets are set', async () => {
  assert.equal(
    (await admin('POST', '/api/admin/system-api-settings', { anthropic_api_key: 'sk-system-secret' })).status,
    200
  );
  const r = await admin('GET', '/api/admin/system-api-settings');
  assert.equal(r.json.has_anthropic_api_key, true);
  assert.ok(!r.text.includes('sk-system-secret'));
});

test('OAuth login binds state to the session and the callback rejects forged state', async () => {
  const login = await alice('GET', `/auth/login?accountId=${ids.alice}`);
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.match(state, new RegExp(`^${ids.alice}\\.[0-9a-f]{32}$`));
  // Forged: someone else's account id, or a nonce this session never issued.
  assert.equal((await alice('GET', `/auth/callback?code=x&state=${ids.bob}.${state.split('.')[1]}`)).status, 400);
  assert.equal((await bob('GET', `/auth/callback?code=x&state=${state}`)).status, 400);
});

test('posts: create, list, and only the owner can delete', async () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await alice('POST', '/api/posts', { accountId: ids.alice, text: '' })).status, 400);
  const id = (await alice('POST', '/api/posts', { accountId: ids.alice, text: '예약 글', scheduled_at: at })).json.id;
  assert.ok(id);
  assert.ok((await alice('GET', `/api/posts?accountId=${ids.alice}`)).json.some(p => p.id === id));
  // Bob deleting through his own account id must not touch Alice's post.
  await bob('DELETE', `/api/posts/${id}?accountId=${ids.bob}`);
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE id=?').get(id), 'post survives a delete from another account');
  await alice('DELETE', `/api/posts/${id}?accountId=${ids.alice}`);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id=?').get(id), undefined);
});

test('dashboard reports KST day buckets', async () => {
  const d = (await alice('GET', `/api/dashboard?accountId=${ids.alice}`)).json;
  assert.equal(d.hourly.length, 24);
  assert.equal(typeof d.totalViews, 'number');
});

test('upload delete is scoped to the caller and referenced files are protected', async () => {
  const { UPLOADS_DIR } = require('../src/config/paths');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, 'in-use.jpg'), 'x');
  db.prepare('INSERT INTO posts(account_id,text,scheduled_at,image_url) VALUES(?,?,?,?)').run(
    ids.bob,
    '밥 글',
    new Date().toISOString(),
    'https://example.test/uploads/in-use.jpg'
  );
  assert.equal((await alice('DELETE', `/api/upload-media/in-use.jpg?accountId=${ids.alice}`)).status, 409);
  assert.ok(fs.existsSync(path.join(UPLOADS_DIR, 'in-use.jpg')));
  assert.equal((await alice('DELETE', `/api/upload-media/in-use.jpg?accountId=${ids.bob}`)).status, 403);
});

test('files used inside a carousel (media bundle) cannot be deleted either', async () => {
  const { UPLOADS_DIR } = require('../src/config/paths');
  const { encodeMediaBundle } = require('../src/threads/mediaBundle');
  fs.writeFileSync(path.join(UPLOADS_DIR, 'carousel-1.jpg'), 'x');
  db.prepare('INSERT INTO posts(account_id,text,scheduled_at,image_url) VALUES(?,?,?,?)').run(
    ids.alice,
    '캐러셀',
    new Date().toISOString(),
    encodeMediaBundle([
      { type: 'IMAGE', url: 'https://example.test/uploads/carousel-1.jpg' },
      { type: 'IMAGE', url: 'https://example.test/uploads/other.jpg' },
    ])
  );
  assert.equal((await alice('DELETE', `/api/upload-media/carousel-1.jpg?accountId=${ids.alice}`)).status, 409);
  assert.ok(fs.existsSync(path.join(UPLOADS_DIR, 'carousel-1.jpg')));
});

test('a legacy mixed-case email blocks a lowercase duplicate signup and can still log in', async () => {
  const { hashPassword } = require('../src/web/auth');
  db.prepare(
    "INSERT INTO users(email,password_hash,name,role,status,expires_at) VALUES('Legacy@Example.com',?,'l','user','active',?)"
  ).run(hashPassword('legacy-pass-1'), new Date(Date.now() + 86400000).toISOString());
  assert.equal(
    (await anon('POST', '/api/auth/signup', { email: 'legacy@example.com', password: 'x', name: 'x||THREADS:x' }))
      .status,
    400
  );
  const legacy = client();
  assert.equal(
    (await legacy('POST', '/api/auth/login', { email: 'Legacy@Example.com', password: 'legacy-pass-1' })).status,
    200
  );
  assert.equal(
    (await legacy('POST', '/api/auth/login', { email: 'legacy@example.com', password: 'legacy-pass-1' })).status,
    200
  );
});

test('product scraping refuses internal addresses', async () => {
  const r = await alice('POST', '/api/scrape-product', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(r.status, 422);
});

test('logout ends the session', async () => {
  assert.equal((await bob('POST', '/api/auth/logout')).status, 200);
  assert.equal((await bob('GET', '/api/accounts')).status, 401);
});
