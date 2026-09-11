'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePublishedThreadsText } = require('./threadsApi');

test('sanitizePublishedThreadsText strips a lone trailing sentence period', () => {
  assert.equal(sanitizePublishedThreadsText('이거 실화냐.'), '이거 실화냐');
  assert.equal(sanitizePublishedThreadsText('문장하나. 문장둘.'), '문장하나 문장둘');
});

test('sanitizePublishedThreadsText preserves decimal points', () => {
  assert.equal(sanitizePublishedThreadsText('가격 1.5만원인데'), '가격 1.5만원인데');
});

test('sanitizePublishedThreadsText preserves ellipses fully, trailing or mid-text', () => {
  // Regression: the previous regex consumed a period from the preceding
  // capture group on each global-flag advance, so a run of 2+ dots always
  // lost exactly one dot (e.g. "완전 신기함..." -> "완전 신기함.."). This
  // directly fought voiceGuide()'s own rule that ellipses are a natural,
  // encouraged part of the persona's voice.
  assert.equal(sanitizePublishedThreadsText('완전 신기함...'), '완전 신기함...');
  assert.equal(sanitizePublishedThreadsText('진짜 이건 미쳤다....'), '진짜 이건 미쳤다....');
  assert.equal(sanitizePublishedThreadsText('말줄임... 근데 진짜'), '말줄임... 근데 진짜');
});

test('sanitizePublishedThreadsText trims trailing whitespace-newline runs', () => {
  assert.equal(sanitizePublishedThreadsText('와 대박.\n진짜임'), '와 대박\n진짜임');
});
