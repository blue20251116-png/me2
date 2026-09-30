'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Loads pipeline.js with every stage replaced by a recording stub, so the composition itself
// (order, which retries cover what, error mapping) is what's under test.
function loadPipeline(overrides = {}) {
  const calls = [];
  const dir = path.join(__dirname, '..', 'src', 'autopilot');
  const stubs = {
    './materialEngine': {
      buildThreadsFirstAutopilot: async () => {
        calls.push('build');
        return { mode: 'product', text: 't' };
      },
    },
    './stages/videoTrigger': {
      addSourceVideoSignal: async r => {
        calls.push('video');
        return r;
      },
    },
    './stages/recipeQuality': {
      checkRecipeAgainstSource: async (a, r) => {
        calls.push('recipe');
        return r;
      },
      recipeFailure: () => new Error('recipe failed'),
      MAX_RECIPE_ATTEMPTS: 3,
    },
    './stages/secretAffiliate': {
      applySecretAffiliate: async (a, r) => {
        calls.push('secret');
        return r;
      },
    },
    './stages/sourceExactProduct': {
      applySourceExactProduct: async r => {
        calls.push('exact');
        return r;
      },
    },
    './stages/sourceLinkPriority': {
      applySourceLinkPriority: async r => {
        calls.push('link');
        return r;
      },
    },
    './stages/finalSanity': {
      withFreshMaterialRounds: async buildOnce => {
        try {
          return await buildOnce();
        } catch (e) {
          if (!e.exhausted) throw e;
          calls.push('round2');
          return buildOnce();
        }
      },
      recheckSourceAndSanitize: async r => {
        calls.push('sanity');
        return r;
      },
    },
    './stages/finalTextGuard': {
      applyFinalTextGuard: r => {
        calls.push('guard');
        return r;
      },
    },
    './stages/qualityHold': {
      isGeminiDown: e => !!e.quota,
      qualityHoldError: e => Object.assign(new Error('hold'), { code: 'AI_QUALITY_HOLD', cause: e }),
    },
  };
  for (const [k, v] of Object.entries(overrides)) stubs[k] = { ...stubs[k], ...v };
  const paths = [];
  for (const [rel, exports] of Object.entries(stubs)) {
    const file = require.resolve(path.join(dir, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
    paths.push(file);
  }
  const pipelinePath = require.resolve(path.join(dir, 'pipeline'));
  delete require.cache[pipelinePath];
  const pipeline = require(pipelinePath);
  for (const p of [...paths, pipelinePath]) delete require.cache[p];
  return { pipeline, calls };
}

test('stages run in the documented order for a normal product post', async () => {
  const { pipeline, calls } = loadPipeline();
  await pipeline.buildAutopilotPost(1, { target: 'x' });
  assert.deepEqual(calls, ['build', 'video', 'secret', 'exact', 'link', 'sanity', 'guard']);
});

test('a recipe that fails the source check rebuilds only the candidate, not the linking stages', async () => {
  let checks = 0;
  const { pipeline, calls } = loadPipeline({
    './materialEngine': {
      buildThreadsFirstAutopilot: async () => {
        calls.push('build');
        return { mode: 'recipe' };
      },
    },
    './stages/recipeQuality': {
      checkRecipeAgainstSource: async (a, r) => {
        calls.push('recipe');
        return ++checks < 3 ? null : r;
      },
    },
  });
  await pipeline.buildAutopilotPost(1, {});
  assert.deepEqual(calls, [
    'build',
    'video',
    'recipe',
    'build',
    'video',
    'recipe',
    'build',
    'video',
    'recipe',
    'secret',
    'exact',
    'link',
    'sanity',
    'guard',
  ]);
});

test('a recipe that never matches its source fails after MAX_RECIPE_ATTEMPTS candidates', async () => {
  const { pipeline, calls } = loadPipeline({
    './materialEngine': {
      buildThreadsFirstAutopilot: async () => {
        calls.push('build');
        return { mode: 'recipe' };
      },
    },
    './stages/recipeQuality': { checkRecipeAgainstSource: async () => null },
  });
  await assert.rejects(pipeline.buildAutopilotPost(1, {}), /recipe failed/);
  assert.equal(calls.filter(c => c === 'build').length, 3);
});

test('the fresh-material round retry covers product linking (a fail-closed link error gets a new batch)', async () => {
  let linkCalls = 0;
  const { pipeline, calls } = loadPipeline({
    './stages/sourceLinkPriority': {
      applySourceLinkPriority: async r => {
        calls.push('link');
        if (++linkCalls === 1) throw Object.assign(new Error('exhausted'), { exhausted: true });
        return r;
      },
    },
  });
  await pipeline.buildAutopilotPost(1, {});
  assert.deepEqual(calls, [
    'build',
    'video',
    'secret',
    'exact',
    'link',
    'round2',
    'build',
    'video',
    'secret',
    'exact',
    'link',
    'sanity',
    'guard',
  ]);
});

test('AI quota errors anywhere become a quality hold instead of canned text', async () => {
  const { pipeline } = loadPipeline({
    './materialEngine': {
      buildThreadsFirstAutopilot: async () => {
        throw Object.assign(new Error('insufficient_quota'), { quota: true });
      },
    },
  });
  await assert.rejects(pipeline.buildAutopilotPost(1, {}), { code: 'AI_QUALITY_HOLD' });
});

test('other errors propagate unchanged', async () => {
  const { pipeline } = loadPipeline({
    './stages/finalTextGuard': {
      applyFinalTextGuard: () => {
        throw Object.assign(new Error('style'), { code: 'CONTENT_STYLE_REJECTED' });
      },
    },
  });
  await assert.rejects(pipeline.buildAutopilotPost(1, {}), { code: 'CONTENT_STYLE_REJECTED' });
});
