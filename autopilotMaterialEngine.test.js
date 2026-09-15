'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubSecret, hasIngredientHeading, hasMethodHeading, normalizeRecipeHeadings } = require('./autopilotMaterialEngine');

// REGRESSION (found via synthetic testing, hourly review): scrubSecret() used a plain
// split/join, which replaced the secret ingredient/product term wherever it appeared as a bare
// substring - including inside a totally different, unrelated compound word. A recipe post whose
// hidden secret ingredient is a common short word like "소금" (salt) or "마늘" (garlic) would have
// any unrelated mention of "소금물" (salt water) or "마늘빵" (garlic bread) mangled into nonsense
// ("비밀 재료물", "비밀 재료빵") before publishing.
test('scrubSecret does not mangle the secret term when it is only a substring of an unrelated compound word', () => {
  assert.equal(scrubSecret('소금물에 살짝 데쳐주세요', '소금', ''), '소금물에 살짝 데쳐주세요');
  assert.equal(scrubSecret('식초물 한 스푼 넣어주세요', '식초', ''), '식초물 한 스푼 넣어주세요');
  assert.equal(scrubSecret('마늘빵이랑 같이 먹으면 더 맛있음', '마늘', ''), '마늘빵이랑 같이 먹으면 더 맛있음');
  assert.equal(scrubSecret('진간장으로 색을 내주세요', '간장', ''), '진간장으로 색을 내주세요');
});

test('scrubSecret still replaces the secret term as a standalone word, with a grammatically correct particle', () => {
  // "비밀 재료" ends in a vowel (료), so a particle carried over unchanged from a
  // consonant-ending secret term ("소금" ends in ㅁ, taking 을/이/은) would be wrong Korean.
  assert.equal(scrubSecret('소금을 넣어주세요', '소금', ''), '비밀 재료를 넣어주세요');
  assert.equal(scrubSecret('소금이 부족해', '소금', ''), '비밀 재료가 부족해');
  assert.equal(scrubSecret('소금은 조금만', '소금', ''), '비밀 재료는 조금만');
  assert.equal(scrubSecret('간장 한 스푼 넣어줘', '간장', ''), '비밀 재료 한 스푼 넣어줘');
  assert.equal(scrubSecret('소금.', '소금', ''), '비밀 재료.');
  assert.equal(scrubSecret('소금', '소금', ''), '비밀 재료');
});

test('scrubSecret scrubs both the secret term and the product name independently', () => {
  const out = scrubSecret('마법의 소금이랑 특제 마늘을 같이 넣어요', '소금', '마늘');
  assert.ok(!out.includes('소금'));
  assert.ok(!out.includes('마늘'));
});

test('scrubSecret takes a custom replacement word, defaulting to "비밀 재료" for backward compatibility', () => {
  // REGRESSION (found live, 2026-09-15): a real published post's BODY still read "비밀 재료
  // 별로라던 남편이..." despite the generation prompt explicitly telling the model never to label
  // the ingredient "비밀 재료" in the body - the model didn't write that literal phrase, this
  // scrubber did, by hardcoding "비밀 재료" as the replacement whenever it caught a leaked secret
  // term. generatePost() now passes a custom replacement ('이거') for the body specifically, while
  // the comment's structured "🥘 재료" ingredient list keeps the default label - a fixed
  // placeholder is correct there since it's a list item, not prose.
  assert.equal(scrubSecret('소금을 넣어주세요', '소금', ''), '비밀 재료를 넣어주세요');
  assert.equal(scrubSecret('소금을 넣어주세요', '소금', '', '이거'), '이거를 넣어주세요');
  assert.equal(scrubSecret('소금이 부족해', '소금', '', '이거'), '이거가 부족해');
  assert.equal(scrubSecret('소금', '소금', '', '이거'), '이거');
});

test('scrubSecret leaves text unchanged when secret/product are empty or too short', () => {
  assert.equal(scrubSecret('그냥 평범한 문장', '', ''), '그냥 평범한 문장');
  assert.equal(scrubSecret('가 붙은 문장', '가', ''), '가 붙은 문장');
});

// REGRESSION (found via synthetic testing, hourly review, 2026-09-14): both heading checks matched
// "재료"/"만드는 법" etc. ANYWHERE in the text with no anchoring, so an ordinary sentence merely
// mentioning the bare word ("이 재료 진짜 신선하고 만들기도 쉬움", with no actual heading structure)
// made both return true - incorrectly signaling a properly-formatted recipe comment when there was
// none. Worse, normalizeRecipeHeadings() used the exact same unanchored pattern to REPLACE the
// first match: on an already well-formed "🥘 재료\n...\n\n🍳 만드는 법\n..." recipe, the unanchored
// \s* before each label greedily ate the newline after it, turning "🥘 재료\n계란 2개" into "🥘
// 재료계란 2개" - corrupting a perfectly good recipe EVERY TIME this ran, since it is called
// unconditionally on every recipe-mode commentLead before any other check.
test('hasIngredientHeading/hasMethodHeading require the label to stand alone on its own line, not just appear anywhere', () => {
  assert.equal(hasIngredientHeading('이 재료 진짜 신선하고 만들기도 쉬움'), false);
  assert.equal(hasMethodHeading('이 재료 진짜 신선하고 만들기도 쉬움'), false);
  assert.equal(hasIngredientHeading('🥘 재료\n계란 2개'), true);
  assert.equal(hasMethodHeading('🍳 만드는 법\n1. 볶는다'), true);
  assert.equal(hasIngredientHeading('재료:\n계란 2개'), true);
  assert.equal(hasMethodHeading('조리 방법:\n1. 볶는다'), true);
});

test('normalizeRecipeHeadings does not corrupt an already well-formed recipe by eating the newline after the label', () => {
  const wellFormed = '🥘 재료\n계란 2개, 대파 1대\n\n🍳 만드는 법\n1. 볶는다\n2. 간한다';
  assert.equal(normalizeRecipeHeadings(wellFormed), wellFormed);
});

test('normalizeRecipeHeadings does not insert a spurious heading into an unrelated sentence that merely mentions the bare word', () => {
  const input = '이 재료들 다 냉장고에 있는 것들임\n\n🥘 재료\n계란 2개, 대파 1대\n\n🍳 만드는 법\n1. 볶는다';
  const out = normalizeRecipeHeadings(input);
  assert.ok(out.startsWith('이 재료들 다 냉장고에 있는 것들임'), `unrelated intro line must stay untouched: ${out}`);
  assert.equal((out.match(/🥘/g) || []).length, 1, `must not duplicate the heading: ${out}`);
});

test('normalizeRecipeHeadings still normalizes bare/colon-variant standalone headers into the canonical emoji form', () => {
  assert.equal(normalizeRecipeHeadings('재료:\n계란 2개\n\n만드는 법:\n1. 볶는다'), '🥘 재료\n계란 2개\n\n🍳 만드는 법\n1. 볶는다');
  assert.equal(normalizeRecipeHeadings('재료\n계란 2개\n\n만들기\n1. 볶는다'), '🥘 재료\n계란 2개\n\n🍳 만드는 법\n1. 볶는다');
});
