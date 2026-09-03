'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real prefill controller with isolated DB/network/clock dependencies.
// No production startup patches, credentials, API calls, or writes are used.
function harness({ generationError, preflightError, env = {} } = {}) {
  let now = Date.parse('2026-09-03T00:00:00Z');
  let tick;
  let searches = 0;
  let generations = 0;
  const account = { id: 1, autopilot_enabled: 1, coupang_access_key: 'abcdef-old', coupang_secret_key: 'old-secret' };
  const scheduler = {
    runAutopilotOnce: async () => { generations++; if (generationError) throw generationError; },
  };
  const Module = { _load: () => scheduler };
  const db = { prepare: sql => ({
    all: () => sql.startsWith('SELECT id FROM accounts') ? [{ id: 1 }] : [],
    get: () => ({ c: 0 }),
    run: () => {},
  }) };
  const dependencies = {
    fs: { readFileSync: () => fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8'), writeFileSync: () => {} },
    path, module: Module, crypto: require('node:crypto'),
    'node-cron': { schedule: (_, fn) => { tick = fn; } },
    './db': { db, getAccount: () => account, getUserById: () => null },
    './coupangApi': {
      hasCredentials: a => !!(a.coupang_access_key && a.coupang_secret_key),
      searchProducts: async () => { searches++; if (preflightError) throw preflightError; return []; },
    },
  };
  const context = vm.createContext({
    require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
    __dirname, process: { env }, global: {}, URL,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout: () => {}, console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'autopilotTimedPrefillPatch.js'), 'utf8'), context);
  Module._load('./scheduler');
  scheduler.startAutopilotJob();
  return {
    account, tick: () => tick(), advance: ms => { now += ms; },
    recover: () => { generationError = null; preflightError = null; },
    stats: () => ({ searches, generations }),
  };
}

const authError = (host, service) => Object.assign(new Error('Unauthorized'), {
  response: { status: 401 }, config: { url: `https://${host}/endpoint` }, ...(service ? { service } : {}),
});

for (const host of ['api.openai.com', 'graph.threads.net', 'media.example.com']) {
  test(`${host} 401 does not block later generation as Coupang-invalid`, async () => {
    const h = harness({ generationError: authError(host) });
    await h.tick();
    assert.equal(h.stats().generations, 1);
    h.recover();
    h.advance(10 * 60000);
    await h.tick();
    assert.equal(h.stats().generations, 3);
  });
}

test('Coupang auth failure is cached briefly then recovers without restart', async () => {
  const h = harness({ generationError: authError('api-gateway.coupang.com') });
  await h.tick();
  await h.tick();
  assert.equal(h.stats().generations, 1);
  h.recover();
  h.advance(10 * 60000);
  await h.tick();
  assert.deepEqual(h.stats(), { searches: 2, generations: 3 });
});

test('same-prefix same-length credential rotation invalidates failure immediately', async () => {
  const h = harness({ preflightError: authError('api-gateway.coupang.com', 'coupang') });
  await h.tick();
  assert.equal(h.stats().generations, 0);
  h.account.coupang_access_key = 'abcdef-new';
  h.account.coupang_secret_key = 'new-secret';
  h.recover();
  await h.tick();
  assert.deepEqual(h.stats(), { searches: 2, generations: 2 });
});

test('legacy six-hour invalid TTL cannot keep an account blocked for six hours', async () => {
  const h = harness({ preflightError: authError('api-gateway.coupang.com'), env: { COUPANG_INVALID_TTL_MS: '21600000' } });
  await h.tick();
  h.recover();
  h.advance(10 * 60000);
  await h.tick();
  assert.equal(h.stats().generations, 2);
});

test('quality hold does not repeatedly consume all remaining slots', async () => {
  const h = harness({ generationError: Object.assign(new Error('quality hold'), { code: 'CONTENT_QUALITY_HOLD' }) });
  await h.tick();
  assert.equal(h.stats().generations, 1);
  h.recover();
  h.advance(10 * 60000);
  await h.tick();
  assert.equal(h.stats().generations, 3);
});
