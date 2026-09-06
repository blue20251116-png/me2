'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshPatchWith(fakePost) {
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = fakePost;
  const patchPath = require.resolve('./openAiRequestDedupePatch');
  delete require.cache[patchPath];
  require(patchPath);
  return { axios, restore() { axios.post = originalPost; delete require.cache[patchPath]; } };
}

test('identical concurrent OpenAI chat requests share one upstream call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = freshPatchWith(async () => {
    calls += 1;
    await gate;
    return { data: { choices: [{ message: { content: 'ok' } }] } };
  });
  try {
    const body = { model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 100, messages: [{ role: 'user', content: 'same' }] };
    const a = ctx.axios.post('https://api.openai.com/v1/chat/completions', body, {});
    const b = ctx.axios.post('https://api.openai.com/v1/chat/completions', body, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  } finally { ctx.restore(); }
});

test('different OpenAI prompts are not coalesced', async () => {
  let calls = 0;
  const ctx = freshPatchWith(async () => { calls += 1; return { data: {} }; });
  try {
    await Promise.all([
      ctx.axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'a' }] }, {}),
      ctx.axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'b' }] }, {}),
    ]);
    assert.equal(calls, 2);
  } finally { ctx.restore(); }
});

test('non-OpenAI requests bypass dedupe', async () => {
  let calls = 0;
  const ctx = freshPatchWith(async () => { calls += 1; return { data: {} }; });
  try {
    await Promise.all([
      ctx.axios.post('https://example.com/api', { same: true }, {}),
      ctx.axios.post('https://example.com/api', { same: true }, {}),
    ]);
    assert.equal(calls, 2);
  } finally { ctx.restore(); }
});
