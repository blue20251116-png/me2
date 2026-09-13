'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRecipe, stripAffiliateNoise } = require('./threadsMaterialWriter');

// REGRESSION (found via synthetic testing, hourly review, 2026-09-13): \b is defined in terms of
// ASCII \w, which no Hangul character is ever part of - so \b좋아요\b (and 답글/리포스트/공유) never
// actually bounded anything, since there is no \w/\W transition between two Hangul characters. This
// line was a silent no-op for every realistic Korean sentence, including the actual scraped
// Threads UI action-button row it exists to strip ("좋아요\n답글\n리포스트\n공유\n129").
test('stripAffiliateNoise strips a scraped Threads UI action-button cluster', () => {
  assert.equal(stripAffiliateNoise('게시글 내용입니다\n좋아요\n답글\n리포스트\n공유\n129'), '게시글 내용입니다');
  assert.equal(stripAffiliateNoise('좋아요 128 · 답글 12'), '');
});

test('stripAffiliateNoise does not strip these words when used as ordinary Korean, only as a UI cluster', () => {
  // A naive Hangul-boundary fix (matching each word whenever isolated) was tried and rejected
  // during this same hourly review: these words are also completely ordinary in real sentences,
  // and stripping them there breaks the sentence ("이거 완전 좋아요ㅋㅋ 진짜 만족함" ->
  // "이거 완전 ㅋㅋ 진짜 만족함") - worse than the original no-op. Only a run of 2+ of these
  // labels back-to-back (the actual shape of a scraped button row) should ever be stripped.
  assert.equal(stripAffiliateNoise('이거 완전 좋아요ㅋㅋ 진짜 만족함'), '이거 완전 좋아요ㅋㅋ 진짜 만족함');
  assert.equal(stripAffiliateNoise('이 상품 안 좋아요 별로임'), '이 상품 안 좋아요 별로임');
  assert.equal(stripAffiliateNoise('공유해주세요 여러분'), '공유해주세요 여러분');
  assert.equal(stripAffiliateNoise('답글 남겨주세요'), '답글 남겨주세요');
});

// REGRESSION (found via synthetic testing, hourly review): "썰" (to cut/slice) alone with a food
// noun used to classify plain kitchen-tool reviews (knives, cutting boards) as recipe mode, which
// applies the wrong persona pool and prompt framing (hiding a "secret ingredient" that doesn't
// exist for a knife) to a product that has nothing to do with cooking instructions.
test('detectRecipe does not misclassify a kitchen-tool review that merely mentions cutting food', () => {
  assert.equal(detectRecipe('이 도마 고기 썰기 진짜 편함ㅋㅋ', '', 'product'), false);
  assert.equal(detectRecipe('이 칼 진짜 잘 썰림 고기든 뭐든', '', 'product'), false);
});

test('detectRecipe still detects an actual recipe described by cooking method or measurement', () => {
  assert.equal(detectRecipe('계란 3개 풀어서 소금 넣고 볶다가 밥 넣고 볶음밥 만듦', '', 'product'), true);
  assert.equal(detectRecipe('된장찌개 끓이는 법: 두부 썰어 넣고 끓이면 끝', '', 'product'), true);
  assert.equal(detectRecipe('오늘 저녁 두부조림 만들었는데 간장 두 큰술 넣음', '', 'product'), true);
});

test('detectRecipe forces true whenever the caller explicitly requests recipe mode', () => {
  assert.equal(detectRecipe('아무 상관없는 텍스트', '', 'recipe'), true);
});

test('detectRecipe returns false for unrelated product text with no food/cooking signal', () => {
  assert.equal(detectRecipe('이 무선청소기 흡입력 진짜 좋음', '', 'product'), false);
});
