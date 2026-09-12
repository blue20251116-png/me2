'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { truncateString, capContent, countTextChars } = require('./openAiBudgetGuardPatch');

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
