'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { isMaterialBatchExhausted, MAX_MATERIAL_ROUNDS } = require('./finalAutopilotSanityPatch');

test('only a fully exhausted material batch is eligible for fresh-candidate retry', () => {
  assert.equal(isMaterialBatchExhausted(new Error('쇼핑 소재 6개를 검사했지만 발행 가능한 상품 연결에 실패했습니다: 18자 초과')), true);
  assert.equal(isMaterialBatchExhausted(new Error('OpenAI API 키가 설정되지 않았습니다')), false);
  assert.equal(isMaterialBatchExhausted(new Error('429 rate limit')), false);
});

test('fresh material retry remains tightly bounded', () => {
  assert.equal(MAX_MATERIAL_ROUNDS, 2);
});
