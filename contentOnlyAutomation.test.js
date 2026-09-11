'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RECIPE_COMMENT_TEASERS, pickRecipeCommentTeaser, buildRecipeText } = require('./contentOnlyAutomation');

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

test('buildRecipeText rejects a high-risk health claim instead of shipping it unguarded', () => {
  // Regression: this no-Coupang-key autopilot path (scheduler.js's runContentOnlyAutopilot)
  // saved generated text straight to the DB via formatThreadsBody(), which only runs
  // formatVoice() (whitespace normalization) - never voiceProblems()/assertVoice(). The one
  // safety net in the repo, finalTextHardGuardPatch.js, only wraps
  // autopilotMaterialEngine.buildThreadsFirstAutopilot (the separate Coupang-product path),
  // so a real high-risk health claim like this sailed straight through completely unchecked.
  assert.throws(
    () => buildRecipeText('이 김치찌개 국물 먹고 염증이 나았어\n진짜 소름', '재료랑 만드는 순서는 댓글에 적어둘게.'),
    { code: 'CONTENT_STYLE_REJECTED' }
  );
});

test('buildRecipeText still returns the combined hook+teaser text for an ordinary recipe hook', () => {
  const text = buildRecipeText('이 김치찌개 국물 미쳤음ㅋㅋ', '재료랑 만드는 순서는 댓글에 적어둘게.');
  assert.match(text, /김치찌개 국물 미쳤음/);
  assert.match(text, /재료랑 만드는 순서는 댓글에 적어둘게\./);
});
