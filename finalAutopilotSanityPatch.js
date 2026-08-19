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

function weakProductHook(text){
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const first = lines[0] || '';
  if (!first) return true;
  if (/(작고|귀엽|기능이|기능도|기능은|엄청 많|다양한 기능|활용하기 좋|괜찮을 거야|찾는다면|추천|꿀템|좋더라|편하더라)/i.test(t)) return true;
  if (/(음악|영상|전자책|카메라|스크롤|셔터|블루투스|기능)/i.test(first)) return true;
  if (lines.length >= 4 && /(그리고|또|까지|여러모로|활용)/i.test(t)) return true;
  if (/(찾는다면|추천해|추천할|괜찮을 거야|사도 될|장만|하나쯤)/i.test(lines[lines.length - 1] || '')) return true;
  return false;
}

async function rewriteProductHook(accountId, result, detail){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) return sanitizeBody(result.text);
  const evidence = sourceEvidence(detail) || String(result.text || '');
  const prompt = `너는 한국 Threads 바이럴 본문 최종 편집기다
생활용품이나 신기한 제품 영상 본문을 사람처럼 짧게 다시 쓴다

절대 규칙
- 2~4줄만 쓴다
- 첫 줄은 제품 설명이 아니라 궁금증 반전 의외성 공감 중 하나로 시작한다
- 첫 줄에 제품명 기능 스펙을 설명하지 않는다
- 기능은 많아도 본문에서는 가장 신기한 기능 1개만 언급한다
- 기능 나열 금지
- 장점 나열 금지
- 마지막에 추천 구매권유 총평을 붙이지 않는다
- '찾는다면 이거 괜찮을 거야' '하나 장만' '꿀템' '추천' 같은 문구 금지
- '작고 귀여운데 기능이 많아' 같은 상품소개형 시작 금지
- 실제로 확인되지 않은 구매 사용 경험을 만들지 않는다
- ㅋㅋ는 필요하면 문장 끝에 최대 1번만 붙이고 단독 줄로 쓰지 않는다
- 마침표와 쉼표를 쓰지 않는다
- 자연스러운 반말만 쓴다
- 영상이 보여주는 내용을 다 설명하지 말고 이게 뭐지 싶은 여백을 남긴다
- 일반제품이면 재료 만드는 법 레시피 같은 말을 절대 쓰지 않는다
JSON만 출력: {"text":""}`;
  const user = `[원본 소재]\n${evidence.slice(0,6000)}\n\n[현재 본문]\n${String(result.text || '').slice(0,1200)}\n\n[판매대상 참고]\n${clean(result?.visionTarget?.soldObject) || clean(result?.topic) || '(없음)'}`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.72,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 45000,
    });
    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const fixed = sanitizeBody(parsed.text || '');
    if (fixed) {
      console.log(`[AutopilotV3][FINAL HOOK] 제품 본문 재작성 완료 before="${sanitizeBody(result.text).replace(/\n/g,' / ')}" after="${fixed.replace(/\n/g,' / ')}"`);
      return fixed;
    }
  } catch (e) {
    console.warn(`[AutopilotV3][FINAL HOOK] 재작성 실패 reason="${e.response?.data?.error?.message || e.message}"`);
  }
  return sanitizeBody(result.text);
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

  let detail = null;
  if (result.sourceUrl && result.sourceUsername) {
    try { detail = await collectPostDetails(result.sourceUrl, result.sourceUsername); }
    catch (e) { console.warn(`[AutopilotV3][FINAL SOURCE] 원문 재확인 실패 reason="${e.message}"`); }
  }

  if (result.mode === 'recipe' && detail) {
    try {
      result.commentLead = await rewriteRecipeFromExactSource(accountId, result, detail);

      const evidence = sourceEvidence(detail);
      const secret = clean(result.secretTerm);
      const secretIsGrounded = secret && evidence.includes(secret);
      const label = affiliateKickLabel(result?.product?.name);
      if (!secretIsGrounded) result.secretTerm = '';
      if (label) {
        result.commentLead = `${String(result.commentLead || '').trim()}\n\n여기 마지막에 ${label} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`.trim();
      }
      console.log(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재검증 완료 source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) {
      console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.response?.data?.error?.message || e.message}"`);
    }
  }

  if (result.mode !== 'recipe' && weakProductHook(result.text)) {
    result.text = await rewriteProductHook(accountId, result, detail);
  }

  result.text = sanitizeBody(result.text);
  return result;
};

console.log('[Autopilot][FINAL SANITY] 본문 2~4줄 + 단독 ㅋㅋ 제거 + 약한 제품후킹 최종 재작성 + 레시피 원문 재검증 활성화');
