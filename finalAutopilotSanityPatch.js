'use strict';

const engine = require('./autopilotMaterialEngine');
const { collectPostDetails } = require('./benchmarkAccounts');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function sanitizeBody(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .split('\n')
    .map(x => x.replace(/\.\s*$/g, '').trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (/^(?:ㅋ{1,6}|ㅎ{1,6}|ㄷㄷ|ㅠ{1,4}|ㅜ{1,4})[!?]*$/.test(line)) {
      if (out.length) out[out.length - 1] += line;
      continue;
    }
    out.push(line);
  }
  return out.slice(0, 6).join('\n').trim();
}

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

function removeUngroundedClaims(text) {
  let s = sanitizeBody(text);
  s = s
    .replace(/나도\s*\d+(?:\.\d+)?\s*(?:주|일|개월)째[^\n]*/gi, '')
    .replace(/\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량했|뺐)[^\n]*/gi, '')
    .replace(/한\s*달\s*만에\s*효과[^\n]*/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return sanitizeBody(s);
}

engine.buildThreadsFirstAutopilot = async function finalAutopilotSanityBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  result.text = removeUngroundedClaims(result.text);
  let detail = null;

  if (result.sourceUrl && result.sourceUsername) {
    try {
      detail = await collectPostDetails(result.sourceUrl, result.sourceUsername);
    } catch (e) {
      console.warn(`[AutopilotV3][FINAL SOURCE] 원문 재확인 실패 reason="${e.message}"`);
    }
  }

  if (result.mode === 'recipe' && detail) {
    try {
      const evidence = sourceEvidence(detail);
      const secret = clean(result.secretTerm);
      const secretIsGrounded = secret && evidence.includes(secret);
      const label = affiliateKickLabel(result?.product?.name);
      if (!secretIsGrounded) result.secretTerm = '';

      // 앞단 RECIPE SOURCE CHECK가 이미 레시피를 AI 검증하므로 여기서는 중복 AI 검수를 하지 않는다.
      if (label && !String(result.commentLead || '').includes(`마지막에 ${label}`)) {
        result.commentLead = `${String(result.commentLead || '').trim()}\n\n여기 마지막에 ${label} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`.trim();
      }
      console.log(`[AutopilotV3][FINAL RECIPE GUARD] local-only source recheck source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) {
      console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.message}"`);
    }
  }

  console.log(`[AutopilotV3][FINAL VOICE] local-only sanitize mode=${result.mode} preview="${result.text.slice(0,160).replace(/\n/g,' / ')}"`);
  result.text = sanitizeBody(result.text);
  return result;
};

console.log('[Autopilot][FINAL SANITY] 중복 AI 호출 제거 · 로컬 사실/형식 재검증 활성화');

module.exports = { sanitizeBody, removeUngroundedClaims, sourceEvidence };
