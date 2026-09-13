'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRecipe } = require('./threadsMaterialWriter');

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
