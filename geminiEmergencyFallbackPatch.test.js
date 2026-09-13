'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isGeminiDown } = require('./geminiEmergencyFallbackPatch');

// REGRESSION (found live, 2026-09-13, in direct response to a user question about Claude credit
// exhaustion): isGeminiDown()'s error-text regex was written for OpenAI's old phrasing and never
// updated for the OpenAI->Claude migration earlier this same day. Anthropic's actual
// insufficient-credit error reads "Your credit balance is too low to access the Claude API..." -
// matching none of the phrases already in the regex - so a real Claude credit-exhaustion error
// would have failed this check and let a low-quality fixed-phrase fallback publish anyway, exactly
// what this guard exists to prevent.
test('isGeminiDown recognizes Anthropic\'s actual insufficient-credit error message', () => {
  const err = new Error('Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.');
  assert.ok(isGeminiDown(err));
});

test('isGeminiDown recognizes insufficient_quota in a nested response error body', () => {
  const err = Object.assign(new Error('Request failed'), {
    response: { data: { error: { type: 'insufficient_quota', message: 'insufficient_quota: account out of credits' } } },
  });
  assert.ok(isGeminiDown(err));
});

test('isGeminiDown still recognizes the pre-existing OpenAI-era phrases and the __openAiNoRetry flag', () => {
  assert.ok(isGeminiDown(new Error('no credits remaining, please add credits')));
  assert.ok(isGeminiDown(Object.assign(new Error('boom'), { __openAiNoRetry: true })));
  assert.ok(isGeminiDown(Object.assign(new Error('boom'), { code: 'OPENAI_HOURLY_BUDGET_EXCEEDED' })));
});

test('isGeminiDown does not flag an ordinary, unrelated error', () => {
  assert.ok(!isGeminiDown(new Error('network timeout')));
  assert.ok(!isGeminiDown(new Error('상품을 찾을 수 없습니다')));
});
