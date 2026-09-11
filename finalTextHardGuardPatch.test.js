'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardCommentLead } = require('./finalTextHardGuardPatch');

test('guardCommentLead rejects a high-risk health claim in a recipe comment, not just non-recipe modes', () => {
  // Regression: this guard used to only run for mode !== 'recipe', so a recipe's
  // "🥘 재료 / 🍳 만드는 법" commentLead had zero health-claim screening at all - even though
  // voiceProblems(..., {comment:true}) already skips every structural check (line count,
  // headers, CTA ending) and only runs highRiskClaim(), making it just as safe to run for
  // recipe mode as for any other mode.
  const badRecipeComment = '🥘 재료\n두부 1모, 대파 1대, 마늘 2쪽\n\n🍳 만드는 법\n1. 두부를 썰어서 볶는다\n2. 이 소스 매일 먹으면 염증이 나아서 진짜 좋음\n3. 소금간 해서 마무리';
  assert.equal(guardCommentLead(badRecipeComment, 'recipe'), '', 'a high-risk health claim must be dropped, not shipped');
});

test('guardCommentLead keeps an ordinary recipe comment intact, headers and all', () => {
  const goodRecipeComment = '🥘 재료\n두부 1모, 대파 1대, 마늘 2쪽\n\n🍳 만드는 법\n1. 두부를 썰어서 볶는다\n2. 소스 넣고 한번 더 볶는다\n3. 소금간 해서 마무리';
  const out = guardCommentLead(goodRecipeComment, 'recipe');
  assert.match(out, /🥘 재료/);
  assert.match(out, /🍳 만드는 법/);
  assert.match(out, /소스 넣고 한번 더 볶는다/);
});

test('guardCommentLead still rejects a high-risk claim for non-recipe modes (existing behavior preserved)', () => {
  assert.equal(guardCommentLead('한 달 만에 5킬로 빠졌어 완전 대박', 'product'), '');
});

test('guardCommentLead passes an empty comment through unchanged', () => {
  assert.equal(guardCommentLead('', 'recipe'), '');
  assert.equal(guardCommentLead(null, 'product'), null);
});
