'use strict';

const engine = require('./autopilotMaterialEngine');
const { collectPostDetails } = require('./benchmarkAccounts');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function sanitizeBody(text) {
  const blocks = String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n\n+/)
    .map(block => block.split('\n').map(x => x.replace(/\.\s*$/g, '').trim()).filter(Boolean))
    .filter(block => block.length);

  const outBlocks = [];
  let total = 0;
  for (const block of blocks) {
    const out = [];
    for (const line of block) {
      if (total >= 8) break;
      if (/^(?:ㅋ{1,6}|ㅎ{1,6}|ㄷㄷ|ㅠ{1,4}|ㅜ{1,4})[!?]*$/.test(line)) {
        if (out.length) out[out.length - 1] += line;
        else if (outBlocks.length) outBlocks[outBlocks.length - 1][outBlocks[outBlocks.length - 1].length - 1] += line;
        continue;
      }
      out.push(line);
      total++;
    }
    if (out.length) outBlocks.push(out);
    if (total >= 8) break;
  }
  return outBlocks.map(block => block.join('\n')).join('\n\n').trim();
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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return sanitizeBody(s);
}

engine.buildThreadsFirstAutopilot = async function finalAutopilotSanityBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  result.text = removeUngroundedClaims(result.text);
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
      if (label && !String(result.commentLead || '').includes(`마지막에 ${label}`)) {
        result.commentLead = `${String(result.commentLead || '').trim()}\n\n여기 마지막에 ${label} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`.trim();
      }
      console.log(`[AutopilotV3][FINAL RECIPE GUARD] local-only source recheck source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) { console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.message}"`); }
  }
  result.text = sanitizeBody(result.text);
  console.log(`[AutopilotV3][FINAL VOICE] v11 paragraph-preserving mode=${result.mode} preview="${result.text.slice(0,160).replace(/\n/g,' / ')}"`);
  return result;
};

console.log('[Autopilot][FINAL SANITY] v11 로컬 사실검사 + 빈줄 보존');
module.exports = { sanitizeBody, removeUngroundedClaims, sourceEvidence };
