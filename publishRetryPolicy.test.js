'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPublishFailure, publishRetryable } = require('./publishRetryPolicy');

test('retries transient failure before any external creation is known', () => {
  const err = Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' });
  const result = classifyPublishFailure(err, 0);
  assert.equal(result.retry, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.attempts, 1);
});

test('never retries automatically when an external creation id is known', () => {
  const err = Object.assign(new Error('publish response lost'), { code: 'ETIMEDOUT', creationId: '123' });
  const result = classifyPublishFailure(err, 0);
  assert.equal(result.retry, false);
  assert.equal(result.outcomeUnknown, true);
});

test('bounds transient retries', () => {
  const err = Object.assign(new Error('rate limited'), { response: { status: 429 } });
  assert.equal(classifyPublishFailure(err, 0).retry, true);
  assert.equal(classifyPublishFailure(err, 1).retry, true);
  assert.equal(classifyPublishFailure(err, 2).retry, false);
});

test('does not retry deterministic client failures', () => {
  const err = Object.assign(new Error('bad request'), { response: { status: 400 } });
  assert.equal(publishRetryable(err), false);
  assert.equal(classifyPublishFailure(err, 0).retry, false);
});
