'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { badRecipe, importantSourceIngredients, recipeContainsIngredient } = require('./recipeQualityPatch');

// REGRESSION (found via synthetic testing, hourly review): buildThreadsFirstAutopilot() already
// runs scrubSecret() before this patch sees result.commentLead, replacing the designated secret
// ingredient's real name with the "비밀 재료"/"비밀 소스" placeholder. importantSourceIngredients()
// pulls from a hardcoded common-ingredient list (마늘/소금/버터 등) that can easily be exactly the
// secret ingredient - when it is, the real name can never legitimately appear in the (correctly
// scrubbed) text, so badRecipe() used to always flag a perfectly valid recipe as bad, forcing
// pointless rewrite attempts and eventually throwing after 3 failures.
test('badRecipe does not flag a recipe as incomplete just because its required ingredient is the intentionally-hidden secret one', () => {
  const result = { secretTerm: '마늘', sourceText: '이 요리에는 마늘이 듬뿍 들어가요' };
  const commentLead = '🥘 재료\n비밀 재료 3쪽\n소금 약간\n\n🍳 만드는 법\n1. 비밀 재료를 다져서 볶는다\n2. 소금간을 한다';
  assert.deepEqual(importantSourceIngredients(result), ['마늘']);
  assert.equal(badRecipe(commentLead, result), false);
});

test('badRecipe still flags a recipe that is missing a required ingredient that is NOT the secret one', () => {
  const result = { secretTerm: '마늘', sourceText: '이 요리에는 마늘이랑 계란이 듬뿍 들어가요' };
  // "계란" never appears anywhere, and it is not the secret ingredient, so this is a real omission.
  const commentLead = '🥘 재료\n비밀 재료 3쪽\n소금 약간\n\n🍳 만드는 법\n1. 비밀 재료를 다져서 볶는다\n2. 소금간을 한다';
  assert.equal(badRecipe(commentLead, result), true);
});

test('badRecipe still flags a recipe missing the secret ingredient placeholder entirely when there is no secret', () => {
  const result = { sourceText: '이 요리에는 소금이 들어가요' };
  const commentLead = '🥘 재료\n후추 약간\n\n🍳 만드는 법\n1. 후추를 뿌린다';
  assert.equal(badRecipe(commentLead, result), true);
});

test('badRecipe does not reject a well-formed recipe just because it puts a colon after the section labels', () => {
  // REGRESSION (found via synthetic testing, hourly review, 2026-09-14): the format check required
  // a literal newline directly after "재료"/"만드는 법", with zero tolerance for a colon - but the
  // system prompt never actually forbids one, and "재료:"/"만드는 법:" is an extremely common,
  // harmless way to format a labeled list. A perfectly complete, source-accurate recipe using that
  // colon variant was rejected as "bad" anyway, forcing a pointless rewrite loop that eventually
  // throws and kills the whole autopilot run for that topic.
  const result = { sourceText: '이 요리에는 계란이랑 대파가 들어가요' };
  const colonRecipe = '🥘 재료:\n계란 2개, 대파 1대, 소금 약간\n\n🍳 만드는 법:\n1. 계란을 풀어 소금을 넣는다\n2. 대파를 썰어 넣고 볶는다';
  assert.equal(badRecipe(colonRecipe, result), false);
  const fullwidthColonRecipe = '🥘 재료：\n계란 2개, 대파 1대, 소금 약간\n\n🍳 만드는 법：\n1. 계란을 풀어 소금을 넣는다\n2. 대파를 썰어 넣고 볶는다';
  assert.equal(badRecipe(fullwidthColonRecipe, result), false);
});

test('recipeContainsIngredient supports checking whether a secret phrase corresponds to a tracked ingredient', () => {
  assert.equal(recipeContainsIngredient('마늘', '마늘'), true);
  assert.equal(recipeContainsIngredient('다진 마늘', '마늘'), true);
  assert.equal(recipeContainsIngredient('소금', '마늘'), false);
});
