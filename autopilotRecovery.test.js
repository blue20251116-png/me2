'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real scheduler.js source with isolated DB/network/clock dependencies.
// No production startup patches, credentials, API calls, or writes are used.
//
// The timed-prefill controller (refillAccount/startAutopilotJob) used to live in a separate
// file (autopilotTimedPrefillPatch.js) that wrapped scheduler.js's exported runAutopilotOnce via
// Module._load, so this harness could swap in a fake generator just by returning a fake
// `scheduler` object from a mocked Module._load. Now that logic lives directly inside
// scheduler.js, runAutopilotOnce is a real local call refillAccount makes within the same file -
// no longer interceptable from the outside. scheduler.js's own refillAccount instead calls
// through `module.exports.runAutopilotOnce` for exactly this reason, so this harness overrides
// that property on the vm context's module.exports after the real file has finished loading
// (defining every other function normally), before ever calling startAutopilotJob().
function harness({ generationError, preflightError, env = {} } = {}) {
  let now = Date.parse('2026-09-03T00:00:00Z');
  let tick;
  let searches = 0;
  let generations = 0;
  const account = { id: 1, autopilot_enabled: 1, threads_access_token: 'test-token', coupang_access_key: 'abcdef-old', coupang_secret_key: 'old-secret' };
  const db = { prepare: sql => ({
    all: () => sql.startsWith('SELECT id FROM accounts') ? [{ id: 1 }] : [],
    get: () => ({ c: 0 }),
    run: () => {},
  }) };
  const dependencies = {
    fs: { readFileSync: () => '', writeFileSync: () => {}, existsSync: () => true, mkdirSync: () => {} },
    path, crypto: require('node:crypto'),
    'node-cron': { schedule: (_, fn) => { tick = fn; } },
    './automationState': { setState() {}, budgetState: () => ({ available: true }) },
    './db': {
      db, getAccount: () => account, getUserById: () => null,
      listAllAccountsForSystem: () => [], canPublish: () => true, logUsage: () => {},
      findMediaSourceForProduct: () => null, markMediaSourceUsed: () => {},
    },
    './threadsApi': {
      publishPost: async () => ({}), publishCarouselPost: async () => ({}),
      publishReply: async () => ({}), getMediaInsights: async () => ({}),
    },
    './coupangApi': {
      hasCredentials: a => !!(a.coupang_access_key && a.coupang_secret_key),
      searchProducts: async () => { searches++; if (preflightError) throw preflightError; return []; },
      getApiCooldown: () => null, isRateLimitError: () => false, createDeeplink: async () => [],
    },
    './contentOnlyAutomation': { generateRecipe: async () => ({}) },
    './autopilotMaterialEngine': { buildThreadsFirstAutopilot: async () => ({}) },
    './threadsMediaImporter': { importThreadsVideo: async () => ({}) },
    './isolatedTask': { getBrowserCircuitState: () => ({ open: false }), browserInfraFailure: () => false },
  };
  const contextModule = { exports: {} };
  const context = vm.createContext({
    require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
    module: contextModule, exports: contextModule.exports,
    __dirname, process: { env }, global: {}, URL,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout: () => {}, console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8'), context);
  contextModule.exports.runAutopilotOnce = async () => { generations++; if (generationError) throw generationError; };
  contextModule.exports.startAutopilotJob();
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

test('missing Threads token prevents browser and AI work', async () => {
  const h=harness();
  h.account.threads_access_token='';
  await h.tick();
  assert.deepEqual(h.stats(),{searches:0,generations:0});
});

test('expired Threads token prevents generation', async () => {
  const h=harness();
  h.account.threads_token_expires_at='2020-01-01T00:00:00Z';
  await h.tick();
  assert.deepEqual(h.stats(),{searches:0,generations:0});
});
