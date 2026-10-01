'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Executes the real src/autopilot/runner.js (plus the real slots/commentText/mediaBundle modules
// it builds on) inside a vm with fake DB/network/clock dependencies. refillAccount calls
// runAutopilotOnce through module.exports, so the harness swaps in a fake generator after load
// to exercise the controller's preflight/retry/circuit logic in isolation.
function harness({ generationError, preflightError, env = {} } = {}) {
  let now = Date.parse('2026-09-03T00:00:00Z');
  let tick;
  let searches = 0;
  let generations = 0;
  const account = {
    id: 1,
    autopilot_enabled: 1,
    threads_access_token: 'test-token',
    coupang_access_key: 'abcdef-old',
    coupang_secret_key: 'old-secret',
  };
  const db = {
    prepare: sql => ({
      all: () => (sql.startsWith('SELECT id FROM accounts') ? [{ id: 1 }] : []),
      get: () => ({ c: 0 }),
      run: () => {},
    }),
  };
  const dependencies = {
    fs: { readFileSync: () => '', writeFileSync: () => {}, existsSync: () => true, mkdirSync: () => {} },
    path,
    crypto: require('node:crypto'),
    'node-cron': {
      schedule: (_, fn) => {
        tick = fn;
      },
    },
    '../config/paths': require('../src/config/paths'),
    '../config/publicUrl': require('../src/config/publicUrl'),
    // The real function (a stub once hid that it wasn't exported at all).
    '../integrations/aiRequestGuard': require('../src/integrations/aiRequestGuard'),
    '../infra/automationState': { setState() {}, budgetState: () => ({ available: true }) },
    '../threads/tokenRefresh': require('../src/threads/tokenRefresh'),
    '../infra/db': {
      db,
      getAccount: () => account,
      getUserById: () => null,
      listAllAccountsForSystem: () => [],
      canPublish: () => true,
      logUsage: () => {},
      findMediaSourceForProduct: () => null,
      markMediaSourceUsed: () => {},
    },
    '../threads/threadsApi': {
      publishPost: async () => ({}),
      publishCarouselPost: async () => ({}),
      publishReply: async () => ({}),
      getMediaInsights: async () => ({}),
    },
    '../integrations/coupangApi': {
      hasCredentials: a => !!(a.coupang_access_key && a.coupang_secret_key),
      searchProducts: async () => {
        searches++;
        if (preflightError) throw preflightError;
        return [];
      },
      getApiCooldown: () => null,
      isRateLimitError: () => false,
      createDeeplink: async () => [],
    },
    '../content/contentOnlyAutomation': { generateRecipe: async () => ({}) },
    './pipeline': { buildAutopilotPost: async () => ({}) },
    '../threads/mediaImporter': { importThreadsVideo: async () => ({}) },
    '../infra/isolatedTask': { getBrowserCircuitState: () => ({ open: false }), browserInfraFailure: () => false },
  };
  const contextModule = { exports: {} };
  const globals = {
    require: name => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    __dirname,
    process: { env },
    global: {},
    URL,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
    setTimeout: () => {},
    console: { log() {}, warn() {}, error() {} },
  };
  const src = rel => path.join(__dirname, '..', 'src', rel);
  // Runs a real source file in the fake environment and returns its exports.
  const loadReal = (rel, moduleObj = { exports: {} }) => {
    vm.runInContext(
      fs.readFileSync(src(rel), 'utf8'),
      vm.createContext({ ...globals, module: moduleObj, exports: moduleObj.exports })
    );
    return moduleObj.exports;
  };
  dependencies['../threads/mediaBundle'] = loadReal('threads/mediaBundle.js');
  dependencies['../publish/commentText'] = loadReal('publish/commentText.js');
  dependencies['../publish/slots'] = loadReal('publish/slots.js');
  loadReal('autopilot/runner.js', contextModule);
  contextModule.exports.runAutopilotOnce = async () => {
    generations++;
    if (generationError) throw generationError;
  };
  contextModule.exports.startAutopilotJob();
  return {
    account,
    tick: () => tick(),
    advance: ms => {
      now += ms;
    },
    recover: () => {
      generationError = null;
      preflightError = null;
    },
    stats: () => ({ searches, generations }),
  };
}

const authError = (host, service) =>
  Object.assign(new Error('Unauthorized'), {
    response: { status: 401 },
    config: { url: `https://${host}/endpoint` },
    ...(service ? { service } : {}),
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
  const h = harness({
    preflightError: authError('api-gateway.coupang.com'),
    env: { COUPANG_INVALID_TTL_MS: '21600000' },
  });
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
  const h = harness();
  h.account.threads_access_token = '';
  await h.tick();
  assert.deepEqual(h.stats(), { searches: 0, generations: 0 });
});

test('expired Threads token prevents generation', async () => {
  const h = harness();
  h.account.threads_token_expires_at = '2020-01-01T00:00:00Z';
  await h.tick();
  assert.deepEqual(h.stats(), { searches: 0, generations: 0 });
});
