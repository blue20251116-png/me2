'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Loads threadsCollector.js with the browser worker replaced by a scripted fake.
function loadCollector(handlers) {
  const calls = [];
  const taskPath = require.resolve(path.join(__dirname, '..', 'src', 'infra', 'isolatedTask'));
  const collectorPath = require.resolve(path.join(__dirname, '..', 'src', 'threads', 'threadsCollector'));
  require.cache[taskPath] = {
    id: taskPath,
    filename: taskPath,
    loaded: true,
    exports: {
      runBrowserTask: async (moduleName, method, args) => {
        calls.push(method);
        assert.equal(moduleName, 'threadsScraper');
        const h = handlers[method];
        if (!h) throw new Error(`unexpected ${method}`);
        return h(...args);
      },
    },
  };
  delete require.cache[collectorPath];
  const collector = require(collectorPath);
  delete require.cache[collectorPath];
  delete require.cache[taskPath];
  return { collector, calls };
}

const URL1 = 'https://www.threads.com/@someone/post/ABC123';

test('post details are cached for repeated reads', async () => {
  const { collector, calls } = loadCollector({ collectPostDetails: async () => ({ sourceText: '본문', images: [] }) });
  assert.equal((await collector.collectPostDetails(URL1, 'someone')).sourceText, '본문');
  assert.equal((await collector.collectPostDetails(`${URL1}/media?x=1`, 'someone')).sourceText, '본문');
  assert.deepEqual(calls, ['collectPostDetails']);
});

test('a 429 puts the URL on cooldown and serves the profile listing instead', async () => {
  const url = 'https://www.threads.com/@someone/post/RATE429';
  const { collector, calls } = loadCollector({
    collectPostDetails: async () => {
      throw Object.assign(new Error('Request failed with status code 429'), { status: 429 });
    },
    collectProfilePosts: async () => [{ url, text: '프로필 본문', images: ['i.jpg'] }],
  });
  const first = await collector.collectPostDetails(url, 'someone');
  assert.equal(first.sourceText, '프로필 본문');
  assert.equal(first.webCooldownFallback, true);
  assert.deepEqual(calls, ['collectPostDetails', 'collectProfilePosts']);
});

test('a post with video but no playable URL gets one extra extraction pass', async () => {
  const url = 'https://www.threads.com/@someone/post/VID1';
  const { collector, calls } = loadCollector({
    collectPostDetails: async () => ({ sourceText: '영상', hasVideo: true, videos: [] }),
    extractPlayableVideoUrls: async () => ['https://cdn.example/v.mp4'],
  });
  const d = await collector.collectPostDetails(url, 'someone');
  assert.deepEqual(d.videos, ['https://cdn.example/v.mp4']);
  assert.deepEqual(calls, ['collectPostDetails', 'extractPlayableVideoUrls']);
});

test('the browser task registry only exposes whitelisted methods', () => {
  const { TASKS, runTask } = require('../src/infra/browserTasks');
  assert.ok(TASKS.threadsScraper.methods.includes('collectPostDetails'));
  assert.throws(() => runTask('threadsScraper', 'constructor', []), /Unsupported browser task/);
  assert.throws(() => runTask('nope', 'x', []), /Unsupported browser task/);
});
