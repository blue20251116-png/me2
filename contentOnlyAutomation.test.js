'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RECIPE_COMMENT_TEASERS, pickRecipeCommentTeaser } = require('./contentOnlyAutomation');

test('recipe comment teaser is not a single hardcoded phrase repeated every time', () => {
  // Regression: generateRecipe() used to append the exact same literal closing
  // sentence to every single post from this unattended (no Coupang keys)
  // autopilot path, directly contradicting voiceGuide()'s own rule that no
  // post should end with an identical fixed phrase every time.
  assert.ok(Array.isArray(RECIPE_COMMENT_TEASERS));
  assert.ok(RECIPE_COMMENT_TEASERS.length >= 3, 'needs real variety, not just one or two options');
  const unique = new Set(RECIPE_COMMENT_TEASERS);
  assert.equal(unique.size, RECIPE_COMMENT_TEASERS.length, 'no duplicate teaser phrases');
});

test('pickRecipeCommentTeaser only returns known teaser phrases', () => {
  for (let i = 0; i < 50; i++) {
    const picked = pickRecipeCommentTeaser();
    assert.ok(RECIPE_COMMENT_TEASERS.includes(picked));
  }
});

test('pickRecipeCommentTeaser actually varies across calls', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickRecipeCommentTeaser());
  assert.ok(seen.size >= 2, 'should not always return the same phrase');
});
