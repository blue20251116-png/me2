'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RECIPE_COMMENT_TEASERS, pickRecipeCommentTeaser, buildRecipeText, buildDailyStorySystemPrompt, looksBloggy } = require('./contentOnlyAutomation');
const { PERSONAS } = require('./threadsPersonas');

test('looksBloggy catches common AI-blog food clichés missing from the explicit list', () => {
  // REGRESSION (found via synthetic testing, hourly review, 2026-09-13): same hardcoded-list
  // under-match class already found and fixed several times this session. "일품이다/일품인",
  // "온 가족이 좋아할", and "누구나 쉽게 따라할 수 있는" are all at least as common in real
  // AI-generated Korean food content as the phrases already in the list, but none of them end in
  // a formal 요./니다. sentence ending either, so they slipped past the list AND the "2+ formal
  // endings" fallback heuristic completely unflagged.
  assert.ok(looksBloggy('따뜻한 국물이 일품인 이 레시피 강추'));
  assert.ok(looksBloggy('이 소스 진짜 일품이다'));
  assert.ok(looksBloggy('온 가족이 좋아할 만한 메뉴예요'));
  assert.ok(looksBloggy('온 가족도 만족할 맛'));
  assert.ok(looksBloggy('누구나 쉽게 따라할 수 있는 초간단 레시피'));
  assert.ok(looksBloggy('누구나 간단하게 만들 수 있음'));
});

test('the new looksBloggy patterns do not flag ordinary casual sentences', () => {
  assert.ok(!looksBloggy('이 냄비 하나로 요리 다 됨'));
  assert.ok(!looksBloggy('오늘 저녁은 이걸로 정함'));
  assert.ok(!looksBloggy('국물 진짜 시원함'));
  assert.ok(!looksBloggy('가족들이 다 좋아함ㅋㅋ'));
  assert.ok(!looksBloggy('이거 진짜 쉬움'));
});

test('looksBloggy also catches "영양 만점"/"든든한 한 끼"/"정성 가득", the same clichés missing from the list', () => {
  // REGRESSION (found via synthetic testing, hourly review, 2026-09-14): same hardcoded-list
  // under-match class as the 일품/온 가족/누구나 fix above. "영양 만점", "든든한 한 끼", "정성 가득"
  // are exactly the same class of blog/marketing food-writing cliche as the already-listed "맛과
  // 영양"/"특별한 저녁·식사·한 끼", but were missing entirely.
  assert.ok(looksBloggy('오늘 저녁으로 든든한 한 끼 준비했어요'));
  assert.ok(looksBloggy('영양 만점 반찬이라 애들도 잘 먹어요'));
  assert.ok(looksBloggy('정성 가득 담아 만들어봤어요'));
  assert.ok(!looksBloggy('오늘 저녁 뭐 해먹지 고민하다가 이거 만듦'));
  assert.ok(!looksBloggy('이거 진짜 정성 들어간 맛임'));
});

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

test('daily story prompt blocks the curiosity persona from deferring its reveal to a comment that never exists', () => {
  // generateDailyStory() returns a plain text-only post - no comment field at all - so if the
  // curiosity persona (which explicitly allows "아예 댓글로 넘긴다") picks that branch, the reveal
  // it promised never actually happens anywhere. Same fix as aiCaption.js's makeSystemPrompt.
  const curiosity = PERSONAS.find(p => p.id === 'curiosity');
  const prompt = buildDailyStorySystemPrompt(curiosity.block);
  assert.ok(prompt.includes(curiosity.block), 'the persona block itself must be present');
  assert.ok(prompt.includes('댓글로 넘기지'), 'a note blocking the comment-defer option must be present');
  assert.ok(prompt.indexOf(curiosity.block) < prompt.indexOf('댓글로 넘기지'), 'the note must come after the persona block it overrides');
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

test('generateRecipe never rotates into the housewife-recipe persona - it has no secret ingredient to reveal', () => {
  // Regression: pickPersona({mode:'recipe'}) can return housewife-recipe, whose whole structure
  // is "build up to a hidden secret sauce/ingredient, reveal it in the comment" - that only makes
  // sense when there's a real affiliate secret ingredient to hide, like
  // autopilotMaterialEngine.js's Coupang-linked recipes have. This no-Coupang-key path's own rule
  // says "상품/구매/광고/제휴 이야기는 절대 넣지 않는다", and its recipeCommentText is just a plain,
  // fully-disclosed ingredient/steps list with nothing marked as "the secret one" - so picking
  // housewife-recipe here would write a hook promising a reveal the comment can never deliver.
  // A full functional test would need to mock callClaudeText/pickPhotos network calls, so this checks
  // the source directly for the fix: the recipe-generation loop must use the reaction persona
  // unconditionally, not pickPersona's recipe-category rotation.
  const src = fs.readFileSync(require.resolve('./contentOnlyAutomation'), 'utf8');
  const loopStart = src.indexOf('for (const topic of topics.slice(0, 6))');
  const loopBody = src.slice(loopStart, src.indexOf('generateDailyStory'));
  assert.ok(loopStart >= 0, 'recipe generation loop not found');
  assert.match(loopBody, /const persona\s*=\s*REACTION_PERSONA/);
  assert.doesNotMatch(loopBody, /const persona\s*=\s*pickPersona\(/, 'the recipe loop must not rotate through pickPersona (would risk housewife-recipe)');
});
