'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function freshPatchWith(fakePost) {
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = fakePost;
  const patchPath = require.resolve('./openAiRequestDedupePatch');
  delete require.cache[patchPath];
  require(patchPath);
  return { axios, restore() { axios.post = originalPost; delete require.cache[patchPath]; } };
}

test('identical concurrent Anthropic requests share one upstream call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = freshPatchWith(async () => {
    calls += 1;
    await gate;
    return { data: { content: [{ type: 'text', text: 'ok' }] } };
  });
  try {
    const body = { model: 'claude-sonnet-4-6', temperature: 0.2, max_tokens: 100, messages: [{ role: 'user', content: 'same' }] };
    const config = { headers: { 'x-api-key': 'key-a' } };
    const a = ctx.axios.post(ANTHROPIC_URL, body, config);
    const b = ctx.axios.post(ANTHROPIC_URL, body, config);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  } finally { ctx.restore(); }
});

test('different Anthropic prompts are not coalesced', async () => {
  let calls = 0;
  const ctx = freshPatchWith(async () => { calls += 1; return { data: {} }; });
  try {
    const config = { headers: { 'x-api-key': 'key-a' } };
    await Promise.all([
      ctx.axios.post(ANTHROPIC_URL, { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'a' }] }, config),
      ctx.axios.post(ANTHROPIC_URL, { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'b' }] }, config),
    ]);
    assert.equal(calls, 2);
  } finally { ctx.restore(); }
});

// REGRESSION (found during the OpenAI->Claude migration, 2026-09-13): Anthropic auth uses the
// x-api-key header, not Authorization - requestKey() used to only read Authorization, so two
// different accounts' identical-content concurrent requests would have collapsed into one shared
// in-flight call regardless of which account's key was used.
test('identical-content requests from two different accounts (different x-api-key) are not coalesced', async () => {
  let calls = 0;
  const ctx = freshPatchWith(async () => { calls += 1; return { data: {} }; });
  try {
    const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'same' }] };
    await Promise.all([
      ctx.axios.post(ANTHROPIC_URL, body, { headers: { 'x-api-key': 'key-a' } }),
      ctx.axios.post(ANTHROPIC_URL, body, { headers: { 'x-api-key': 'key-b' } }),
    ]);
    assert.equal(calls, 2);
  } finally { ctx.restore(); }
});

test('non-Anthropic requests bypass dedupe', async () => {
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
