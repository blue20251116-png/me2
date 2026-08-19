const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { collectPostDetails } = require('./benchmarkAccounts');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v || '').replace(/\s+/g, ' ').trim(); }
function getOpenAIKey(accountId){
  const a = getAccount(accountId), s = getSystemApiSettings();
  return s.openai_api_key || process.env.OPENAI_API_KEY || a?.openai_api_key || null;
}

function sanitizeBody(text){
  let lines = String(text || '')
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

  return out.slice(0, 4).join('\n').trim();
}

function sourceEvidence(detail){
  return [
    detail?.sourceText,
    ...(Array.isArray(detail?.authorReplies) ? detail.authorReplies : []),
  ].map(v => String(v || '')).filter(Boolean).join('\n');
}

function affiliateKickLabel(productName){
  const n = clean(productName);
  if (!n) return '';
  if (/들기름/i.test(n)) return '들기름';
  if (/참기름/i.test(n)) return '참기름';
  if (/버터/i.test(n)) return '버터';
  if (/치즈/i.test(n)) return '치즈';
  if (/소스|양념|드레싱|시즈닝|간장|고추장|된장|액젓|식초/i.test(n)) return '소스';
  return '';
}

async function rewriteRecipeFromExactSource(accountId, result, detail){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) return String(result.commentLead || '').trim();

  const evidence = sourceEvidence(detail);
  if (!evidence.trim()) return String(result.commentLead || '').trim();

  const prompt = `너는 Threads 레시피 댓글 최종 검수기다
원본 게시물과 원작성자 댓글에 명시된 재료와 조리법만 사용해 레시피를 다시 정리한다

절대 규칙
- 원본에 이름이 없는 식재료를 절대 추측하거나 추가하지 않는다
- 원본이 단지 '비밀 재료' 또는 '비밀 소스'라고만 말하면 정확한 재료명을 추측하지 않는다
- 쿠팡 상품명이나 제휴상품을 레시피 재료 목록과 만드는 법에 임의로 넣지 않는다
- 기존 댓글에 원본에 없는 밥새우 새우 치즈 소스 등 임의 재료가 섞였으면 제거한다
- 소금 후추 식용유 같은 기본 조미료도 원본에 없으면 가급적 추가하지 않는다
- 🥘 재료와 🍳 만드는 법 두 섹션만 출력한다
- 재료는 원본에서 확인되는 것만 쓴다
- 만드는 법도 원본에서 확인되는 범위만 간단히 정리한다
- 자연스러운 반말을 쓴다
- 문장 끝 마침표는 쓰지 않는다
- 링크 광고고지 제휴문구는 쓰지 않는다
JSON만 출력: {"commentLead":""}`;

  const user = `[원본 게시물/원작성자 댓글]\n${evidence.slice(0,7000)}\n\n[현재 생성 댓글 - 오류가 있을 수 있음]\n${String(result.commentLead || '').slice(0,3000)}`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.05,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 45000,
    });
    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const fixed = String(parsed.commentLead || '').replace(/\r/g, '').trim();
    return fixed || String(result.commentLead || '').trim();
  } catch (e) {
    console.warn(`[AutopilotV3][FINAL RECIPE GUARD] AI 검수 실패 reason="${e.response?.data?.error?.message || e.message}"`);
    return String(result.commentLead || '').trim();
  }
}

engine.buildThreadsFirstAutopilot = async function finalAutopilotSanityBuild(accountId, options){
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  result.text = sanitizeBody(result.text);

  if (result.mode === 'recipe' && result.sourceUrl && result.sourceUsername) {
    try {
      const detail = await collectPostDetails(result.sourceUrl, result.sourceUsername);
      result.commentLead = await rewriteRecipeFromExactSource(accountId, result, detail);

      const evidence = sourceEvidence(detail);
      const secret = clean(result.secretTerm);
      const secretIsGrounded = secret && evidence.includes(secret);
      const label = affiliateKickLabel(result?.product?.name);

      // 원문에 정확한 비밀재료명이 없으면 AI가 추측한 secretTerm은 사용자에게 노출하지 않는다
      if (!secretIsGrounded) result.secretTerm = '';

      // 링크 앞 추천 문구는 최종 연결 상품이 소스/기름/치즈처럼 요리에 자연스럽게 더할 수 있을 때만 붙인다
      if (label) {
        result.commentLead = `${String(result.commentLead || '').trim()}\n\n여기 마지막에 ${label} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`.trim();
      }

      console.log(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재검증 완료 source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) {
      console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.response?.data?.error?.message || e.message}"`);
    }
  }

  // 모든 모드에서 마지막으로 한 번 더 ㅋㅋ 단독줄과 문장부호를 정리한다
  result.text = sanitizeBody(result.text);
  return result;
};

console.log('[Autopilot][FINAL SANITY] 본문 2~4줄 정리 + 단독 ㅋㅋ 제거 + 레시피 원문 재검증 활성화');
