'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SAFE_ARGS, mergeSafeArgs, isLaunchCrash } = require('./railwayBrowserGuardPatch');

test('mergeSafeArgs preserves caller args and enforces Railway-safe Chromium flags', () => {
  const args = mergeSafeArgs(['--foo', '--no-sandbox']);
  assert.equal(args.filter(v => v === '--no-sandbox').length, 1);
  assert.ok(args.includes('--foo'));
  for (const arg of SAFE_ARGS) assert.ok(args.includes(arg), `missing ${arg}`);
});

test('mergeSafeArgs tolerates non-array input', () => {
  const args = mergeSafeArgs(null);
  for (const arg of SAFE_ARGS) assert.ok(args.includes(arg));
});

test('launch crash detector matches Railway Playwright SIGTRAP signatures', () => {
  assert.equal(isLaunchCrash(new Error('browserType.launch: Target page, context or browser has been closed')), true);
  assert.equal(isLaunchCrash(new Error('process did exit: signal=SIGTRAP')), true);
  assert.equal(isLaunchCrash(new Error('ordinary content error')), false);
});
