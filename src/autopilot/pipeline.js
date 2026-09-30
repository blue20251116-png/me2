'use strict';
// Autopilot: turn a benchmark Threads post into a ready-to-schedule post with a Coupang product.
//
//   buildAutopilotPost
//   └─ quality hold: AI quota/credit errors never fall back to canned text
//      └─ fresh-material rounds: exhausted batch → fetch a new batch (bounded)
//         ├─ recipe-checked candidate (up to 3 candidates)
//         │   ├─ materialEngine.buildThreadsFirstAutopilot  (pick material, analyze, write, match product)
//         │   ├─ addSourceVideoSignal                        (unresolved source video → run importer later)
//         │   └─ checkRecipeAgainstSource                    (recipe comment must match the source)
//         ├─ applySecretAffiliate    (recipe: link the hidden kick ingredient)
//         ├─ applySourceExactProduct (author's own Coupang link wins)
//         └─ applySourceLinkPriority (resolve author link by redirect; fail closed if ambiguous)
//      ├─ recheckSourceAndSanitize
//      └─ applyFinalTextGuard (shared voice policy)
const { buildThreadsFirstAutopilot } = require('./materialEngine');
const { addSourceVideoSignal } = require('./stages/videoTrigger');
const { checkRecipeAgainstSource, recipeFailure, MAX_RECIPE_ATTEMPTS } = require('./stages/recipeQuality');
const { applySecretAffiliate } = require('./stages/secretAffiliate');
const { applySourceExactProduct } = require('./stages/sourceExactProduct');
const { applySourceLinkPriority } = require('./stages/sourceLinkPriority');
const { withFreshMaterialRounds, recheckSourceAndSanitize } = require('./stages/finalSanity');
const { applyFinalTextGuard } = require('./stages/finalTextGuard');
const { isGeminiDown, qualityHoldError } = require('./stages/qualityHold');

async function buildCandidate(accountId, options) {
  return addSourceVideoSignal(await buildThreadsFirstAutopilot(accountId, options));
}

async function buildRecipeCheckedCandidate(accountId, options) {
  let last;
  for (let attempt = 1; attempt <= MAX_RECIPE_ATTEMPTS; attempt++) {
    const candidate = await buildCandidate(accountId, options);
    if (candidate?.mode !== 'recipe') return candidate;
    last = candidate;
    const checked = await checkRecipeAgainstSource(accountId, candidate, attempt);
    if (checked) return checked;
  }
  throw recipeFailure(last);
}

async function buildLinkedCandidate(accountId, options) {
  let result = await buildRecipeCheckedCandidate(accountId, options);
  result = await applySecretAffiliate(accountId, result);
  result = await applySourceExactProduct(result);
  result = await applySourceLinkPriority(result);
  return result;
}

async function buildAutopilotPost(accountId, options) {
  try {
    const result = await withFreshMaterialRounds(() => buildLinkedCandidate(accountId, options));
    return applyFinalTextGuard(await recheckSourceAndSanitize(result));
  } catch (e) {
    if (!isGeminiDown(e)) throw e;
    // 품질 우선: AI 호출 제한 시 고정문구를 발행하지 않고, 소재를 보존해 정상화 후 다시 시도한다.
    console.warn('[AutopilotV3][QUALITY HOLD] AI 호출 제한/크레딧 제한 감지 → 고정문구 fallback 발행 차단 · 소재 보존');
    throw qualityHoldError(e);
  }
}

module.exports = { buildAutopilotPost };
