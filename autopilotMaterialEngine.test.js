'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubSecret } = require('./autopilotMaterialEngine');

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

test('scrubSecret leaves text unchanged when secret/product are empty or too short', () => {
  assert.equal(scrubSecret('그냥 평범한 문장', '', ''), '그냥 평범한 문장');
  assert.equal(scrubSecret('가 붙은 문장', '가', ''), '가 붙은 문장');
});
