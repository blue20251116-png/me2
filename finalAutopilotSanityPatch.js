'use strict';
const { normalizeVoice } = require('./threadsVoicePolicy');

const engine = require('./autopilotMaterialEngine');
const { collectPostDetails } = require('./benchmarkAccounts');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);
const MAX_MATERIAL_ROUNDS = 2;

function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function sanitizeBody(text) { return normalizeVoice(text); }

function sourceEvidence(detail) {
  return [detail?.sourceText, ...(Array.isArray(detail?.authorReplies) ? detail.authorReplies : [])]
    .map(v => String(v || '')).filter(Boolean).join('\n');
}

function affiliateKickLabel(productName) {
  const n = clean(productName);
  if (!n) return '';
  if (/들기름/i.test(n)) return '들기름';
  if (/참기름/i.test(n)) return '참기름';
  if (/버터/i.test(n)) return '버터';
  if (/치즈/i.test(n)) return '치즈';
  if (/소스|양념|드레싱|시즈닝|간장|고추장|된장|액젓|식초/i.test(n)) return '소스';
  return '';
}

function isMaterialBatchExhausted(error) {
  return /^쇼핑 소재 \d+개를 검사했지만 발행 가능한 상품 연결에 실패했습니다/.test(String(error?.message || ''));
}

async function buildWithFreshMaterialRetry(accountId, options) {
  let lastError = null;
  for (let round = 1; round <= MAX_MATERIAL_ROUNDS; round++) {
    try {
      if (round > 1) console.log(`[AutopilotV3][YIELD RETRY] 새 소재 묶음 재탐색 round=${round}/${MAX_MATERIAL_ROUNDS}`);
      return await originalBuild(accountId, options);
    } catch (error) {
      lastError = error;
      if (!isMaterialBatchExhausted(error) || round >= MAX_MATERIAL_ROUNDS) throw error;
      console.warn(`[AutopilotV3][YIELD RETRY] 소재 묶음 소진 → 새 후보로 1회 추가 시도 reason="${error.message}"`);
    }
  }
  throw lastError;
}

engine.buildThreadsFirstAutopilot = async function finalAutopilotSanityBuild(accountId, options) {
  const result = await buildWithFreshMaterialRetry(accountId, options);
  if (!result) return result;
  let detail = null;
  if (result.sourceUrl && result.sourceUsername) {
    try { detail = await collectPostDetails(result.sourceUrl, result.sourceUsername); }
    catch (e) { console.warn(`[AutopilotV3][FINAL SOURCE] 원문 재확인 실패 reason="${e.message}"`); }
  }
  if (result.mode === 'recipe' && detail) {
    try {
      const evidence = sourceEvidence(detail);
      const secret = clean(result.secretTerm);
      const secretIsGrounded = secret && evidence.includes(secret);
      const label = affiliateKickLabel(result?.product?.name);
      if (!secretIsGrounded) result.secretTerm = '';
      console.log(`[AutopilotV3][FINAL RECIPE GUARD] local-only source recheck source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) { console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.message}"`); }
  }
  result.text = sanitizeBody(result.text);
  console.log(`[AutopilotV3][FINAL VOICE] v12 yield-retry mode=${result.mode} preview="${result.text.slice(0,160).replace(/\n/g,' / ')}"`);
  return result;
};

console.log('[Autopilot][FINAL SANITY] source/affiliate check + bounded fresh-material yield retry');
module.exports = { sanitizeBody, sourceEvidence, isMaterialBatchExhausted, MAX_MATERIAL_ROUNDS };
