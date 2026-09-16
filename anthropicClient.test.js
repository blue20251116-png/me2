'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, imageBlock, imageBlockFromDataUri, looksLikeAnthropicKey } = require('./anthropicClient');

test('extractJson parses a clean JSON object with no wrapping', () => {
  assert.deepEqual(extractJson('{"text":"hi"}'), { text: 'hi' });
});

test('extractJson strips ```json code fences', () => {
  assert.deepEqual(extractJson('```json\n{"text":"hi"}\n```'), { text: 'hi' });
  assert.deepEqual(extractJson('```JSON\n{"text":"hi"}\n```'), { text: 'hi' });
});

// REGRESSION (found via review, hourly review, 2026-09-13): this used to try matching a bare
// array substring BEFORE the full object. Nearly every JSON schema this app asks Claude for is a
// top-level object that itself contains an array value ({"items":[...]}, {"searchTerms":[...]}),
// so whenever the model wrapped its answer in any surrounding prose (breaking the direct parse),
// the array-first check greedily matched just the inner array and parsed it successfully on its
// own - silently discarding the object it actually belonged to and losing the wrapper key.
test('extractJson returns the full wrapping object, not just an array value nested inside it', () => {
  const wrapped = 'Here are the 5 variants:\n{"items":[{"text":"a"},{"text":"b"}]}\nLet me know if you need changes.';
  assert.deepEqual(extractJson(wrapped), { items: [{ text: 'a' }, { text: 'b' }] });
});

test('extractJson still correctly parses a bare top-level array when that really is the schema (frameVision.js)', () => {
  const wrapped = 'Sure, here is the analysis:\n[{"frameId":"a","score":90},{"frameId":"b","score":40}]';
  assert.deepEqual(extractJson(wrapped), [{ frameId: 'a', score: 90 }, { frameId: 'b', score: 40 }]);
});

test('extractJson handles a plain object wrapped in prose with no nested array', () => {
  assert.deepEqual(extractJson('Sure! {"text":"hi"} Hope that helps.'), { text: 'hi' });
});

test('extractJson throws a clear error when no JSON can be found at all', () => {
  assert.throws(() => extractJson('no json here at all'));
});

test('imageBlock builds an OpenAI image_url content part', () => {
  assert.deepEqual(imageBlock('https://example.com/a.jpg'), {
    type: 'image_url',
    image_url: { url: 'https://example.com/a.jpg' },
  });
});

test('imageBlockFromDataUri passes a data URI straight through in image_url.url', () => {
  const block = imageBlockFromDataUri('data:image/jpeg;base64,QQ==');
  assert.deepEqual(block, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } });
});

test('imageBlockFromDataUri rejects a non-data-URI input', () => {
  assert.throws(() => imageBlockFromDataUri('https://example.com/a.jpg'));
});

// Added 2026-09-16 alongside the OpenAI revert: the stale anthropic_api_key DB field / env
// var may still hold a real `sk-ant-...` Claude key left over from the 2026-09-13 migration.
// callAnthropic() must not forward that to OpenAI (guaranteed 401) - it should fall back to
// the shared OPENAI_API_KEY instead, while still honoring a legitimate per-account key that
// happens to already be OpenAI-shaped.
test('looksLikeAnthropicKey flags an sk-ant- prefixed key', () => {
  assert.equal(looksLikeAnthropicKey('sk-ant-api03-abc123'), true);
});

test('looksLikeAnthropicKey does not flag an OpenAI-shaped key or empty input', () => {
  assert.equal(looksLikeAnthropicKey('sk-proj-abc123'), false);
  assert.equal(looksLikeAnthropicKey(''), false);
  assert.equal(looksLikeAnthropicKey(null), false);
  assert.equal(looksLikeAnthropicKey(undefined), false);
});
