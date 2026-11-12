'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPublishFailure, publishRetryable } = require('../src/publish/publishRetryPolicy');

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

test('publishErrorText keeps what Threads answered, never the token (dev 1ea14eaf)', () => {
  const { publishErrorText } = require('../src/publish/publishRetryPolicy');
  const err = Object.assign(new Error('Request failed with status code 400'), {
    code: 'ERR_BAD_REQUEST',
    config: { url: 'https://graph.threads.net/v1.0/me/threads?access_token=SECRET' },
    response: { status: 400, data: { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2207052, error_user_msg: 'Media download has failed.' } } },
  });
  const text = publishErrorText(err);
  assert.match(text, /^ERR_BAD_REQUEST HTTP 400 Invalid parameter \(OAuthException, code 100, subcode 2207052\) Media download has failed\.$/);
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(publishErrorText(Object.assign(new Error('THREADS_TOKEN_MISSING'), {})), 'THREADS_TOKEN_MISSING');
});
