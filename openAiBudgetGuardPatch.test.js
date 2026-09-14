'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { truncateString, capContent, countTextChars, capRequestText, MAX_TEXT_CHARS, retryAfterMs } = require('./openAiBudgetGuardPatch');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function freshPatchWith(fakePost) {
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = fakePost;
  const patchPath = require.resolve('./openAiBudgetGuardPatch');
  delete require.cache[patchPath];
  require(patchPath);
  return { axios, restore() { axios.post = originalPost; delete require.cache[patchPath]; } };
}

// The in-flight dedupe used to live in a separate file (openAiRequestDedupePatch.js) that wrapped
// this file's own axios.post override as an outer layer. Folded directly into this file's own
// override; these tests moved with it.
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

test('non-Anthropic requests bypass dedupe and the budget guard entirely', async () => {
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

// REGRESSION (found via synthetic testing, hourly review): truncateString()'s head/tail had
// hardcoded minimums (1000/500) that ignored the requested `max` once it dropped below ~1500 -
// truncateString(text, 200) still returned ~1548 chars. capContent() calls this per-field with a
// shrinking shared budget, so once earlier fields in a multi-field OpenAI request had already
// consumed most of MAX_TEXT_CHARS, every later large field would still emit ~1500+ chars
// regardless of how little budget remained - silently blowing past the cap this file exists to
// enforce.
test('truncateString never returns more than the requested max, even for a small max', () => {
  const longText = 'x'.repeat(30000);
  for (const max of [10, 50, 200, 1000, 5000]) {
    const out = truncateString(longText, max);
    assert.ok(out.length <= max, `truncateString(text, ${max}) returned ${out.length} chars, expected <= ${max}`);
  }
});

test('truncateString returns text unchanged when it already fits', () => {
  assert.equal(truncateString('짧은 문장', 100), '짧은 문장');
});

test('truncateString still preserves head and tail context for a reasonably large max', () => {
  const longText = 'HEAD'.repeat(1000) + 'MIDDLE' + 'TAIL'.repeat(1000);
  const out = truncateString(longText, 2000);
  assert.ok(out.startsWith('HEAD'));
  assert.ok(out.endsWith('TAIL'));
  assert.ok(out.length <= 2000);
});

test('capContent keeps the cumulative truncated output within the requested budget across multiple large fields', () => {
  // Simulates the real bug scenario: several large string fields in one request, processed with
  // a single shared shrinking budget (as capRequestText does via the `state` object).
  const fields = ['a'.repeat(10000), 'b'.repeat(10000), 'c'.repeat(10000), 'd'.repeat(10000)];
  const state = { used: 0 };
  const capped = fields.map(f => capContent(f, state));
  const totalOut = capped.reduce((n, s) => n + s.length, 0);
  assert.ok(totalOut <= 18000 + 300, `total capped output ${totalOut} should stay close to the 18000-char budget, not balloon past it`);
});

test('countTextChars ignores the url string itself when summing text length', () => {
  // The long URL/data string is excluded from the text budget - only its wrapper key name (an
  // unrelated coincidence like a "type" field literally reading "image_url") still counts.
  const messages = [{ content: [{ note: 'hello', image_url: { url: 'https://example.com/x.jpg' } }] }];
  assert.equal(countTextChars(messages), 'hello'.length);
});

// REGRESSION (found during the OpenAI->Claude migration, 2026-09-13): OpenAI puts the system
// prompt inside messages[] as a {role:'system'} entry, but Anthropic's Messages API sends it as a
// separate top-level `system` string - often the largest single field (voiceGuide() alone runs to
// several thousand characters). capRequestText() used to only look at data.messages, so it would
// have silently stopped counting/capping the system prompt the moment callers switched to Claude's
// request shape, defeating the cost cap for exactly the biggest field in most requests.
test('capRequestText caps the top-level Anthropic-style system field, not just messages', () => {
  const data = { model: 'claude-sonnet-4-6', system: 'S'.repeat(30000), messages: [{ role: 'user', content: 'hi' }] };
  const capped = capRequestText(data);
  assert.ok(capped.system.length < data.system.length, 'the oversized system field must actually be truncated');
  assert.ok(countTextChars({ system: capped.system, messages: capped.messages }) <= MAX_TEXT_CHARS + 300);
});

test('capRequestText leaves a request under budget untouched', () => {
  const data = { model: 'claude-sonnet-4-6', system: 'short system', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(capRequestText(data), data);
});

// REGRESSION (found via review, hourly review, 2026-09-13): the only way this ever computed a
// precise retry delay was parsing OpenAI's specific "please try again in Xs" message text - which
// never appears in an Anthropic 429 response, so every real Claude rate-limit hit silently fell
// back to the generic 1800ms default regardless of what the server actually asked for.
test('retryAfterMs prefers the standard retry-after response header over message-text parsing', () => {
  const e = { response: { headers: { 'retry-after': '3' }, data: { error: { message: 'rate_limit_error' } } } };
  assert.equal(retryAfterMs(e), 3000);
});

test('retryAfterMs falls back to parsing OpenAI-style "try again in Xs/Xms" message text when no header is present', () => {
  assert.equal(retryAfterMs({ message: 'Rate limited, please try again in 2.5s' }), 2500);
  assert.equal(retryAfterMs({ message: 'please try again in 900ms' }), 900);
});

test('retryAfterMs falls back to a sane default when neither a header nor parseable text is present', () => {
  assert.equal(retryAfterMs({ message: 'rate_limit_error' }), 1800);
  assert.equal(retryAfterMs({}), 1800);
});
