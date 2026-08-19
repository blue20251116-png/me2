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
  return out.slice(0, 6).join('\n').trim();
}

function sourceEvidence(detail){
  return [detail?.sourceText, ...(Array.isArray(detail?.authorReplies) ? detail.authorReplies : [])]
    .map(v => String(v || '')).filter(Boolean).join('\n');
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
  if (/(작고|귀엽|기능이|기능도|기능은|엄청 많|다양한 기능|활용하기 좋|괜찮을 거야|찾는다면|추천|꿀템|좋더라|편하더라|하더라|더라고)/i.test(t)) return true;
  if (/(음악|영상|전자책|카메라|스크롤|셔터|블루투스|기능)/i.test(first)) return true;
  if (lines.length >= 4 && /(그리고|또|까지|여러모로|활용)/i.test(t)) return true;
  if (/(찾는다면|추천해|추천할|괜찮을 거야|사도 될|장만|하나쯤)/i.test(lines[lines.length - 1] || '')) return true;
  return false;
}

async function rewriteReactionPost(accountId, result, detail){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) return sanitizeBody(result.text);
  const evidence = sourceEvidence(detail) || String(result.text || '');
  const isRecipe = result.mode === 'recipe';
  const prompt = `너는 한국 Threads에서 반응 좋은 짧은 게시물을 쓰는 사람이다
원본 영상이나 사진을 본 사람이 친구에게 바로 말하듯 본문을 다시 쓴다
상품 설명이나 정보 요약이 아니라 사람의 첫 반응이 중심이다

원하는 결의 예시
볶음밥 소재라면 이런 호흡이다
볶음밥에 이 조합은 처음 봐
처음엔 이게 맞나 싶었는데
완성된 거 보니까 생각 바뀜ㅋㅋ
오늘 저녁은 정해졌다

중요: 위 문장을 복사하지 말고 말하는 방식과 밀도만 참고한다

절대 규칙
- 보통 3~5줄이 가장 자연스럽지만 소재에 따라 2~6줄까지 허용한다
- 줄 수를 채우려고 문장을 추가하지 않는다
- 첫 문장부터 제품 설명 스펙 기능 나열을 하지 않는다
- 소재를 보고 실제 사람이 할 법한 반응이나 생각으로 시작한다
- 설명보다 반응이 앞선다
- 기능이나 특징은 정말 필요할 때 가장 눈에 띄는 것 1개만 쓴다
- 영상이 이미 보여주는 내용을 친절하게 다시 설명하지 않는다
- 추천 구매권유 총평을 붙이지 않는다
- '찾는다면 이거 괜찮을 거야' '하나 장만' '꿀템' '추천' 금지
- '~더라' '~하더라' '~더라고' 같은 AI 후기체를 쓰지 않는다
- 같은 종결어미를 반복하지 않는다
- ㅋㅋ는 필요할 때만 최대 1회 사용하고 단독 줄로 쓰지 않는다
- 확인되지 않은 실제 구매 사용 경험을 만들지 않는다
- 마침표와 쉼표를 쓰지 않는다
- 자연스러운 반말을 쓴다
- 음슴체를 쓰지 않는다
- 일반제품 본문에는 재료 만드는 법 레시피 요리법 조리법을 쓰지 않는다
- 레시피 본문에서도 재료와 만드는 법을 설명하지 않는다 그 정보는 댓글 영역의 역할이다
- 매번 '이거 만든 사람'으로 시작하지 않는다
- 매번 질문으로 시작하지 않는다
- 매번 마지막을 '못 참지' 같은 고정문구로 끝내지 않는다
JSON만 출력: {"text":""}`;

  const user = `[원본 소재]\n${evidence.slice(0,6000)}\n\n[현재 본문]\n${String(result.text || '').slice(0,1200)}\n\n[소재 종류]\n${isRecipe ? '음식/레시피' : '일반 생활/제품'}\n\n[대상 참고]\n${clean(result?.visionTarget?.soldObject) || clean(result?.topic) || '(없음)'}`;
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', temperature: 0.86, max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });
    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const fixed = sanitizeBody(parsed.text || '');
    if (fixed) {
      console.log(`[AutopilotV3][FINAL VOICE] 반응형 본문 재작성 완료 mode=${result.mode} before="${sanitizeBody(result.text).replace(/\n/g,' / ')}" after="${fixed.replace(/\n/g,' / ')}"`);
      return fixed;
    }
  } catch (e) {
    console.warn(`[AutopilotV3][FINAL VOICE] 재작성 실패 reason="${e.response?.data?.error?.message || e.message}"`);
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
- 원본이 단지 비밀 재료 또는 비밀 소스라고만 말하면 정확한 재료명을 추측하지 않는다
- 쿠팡 상품명이나 제휴상품을 레시피 재료 목록과 만드는 법에 임의로 넣지 않는다
- 기존 댓글에 원본에 없는 임의 재료가 섞였으면 제거한다
- 기본 조미료도 원본에 없으면 가급적 추가하지 않는다
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
      model: 'gpt-4o-mini', temperature: 0.05, max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });
    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    return String(parsed.commentLead || '').replace(/\r/g, '').trim() || String(result.commentLead || '').trim();
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
      if (label) result.commentLead = `${String(result.commentLead || '').trim()}\n\n여기 마지막에 ${label} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`.trim();
      console.log(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재검증 완료 source=${result.sourceUrl} kick=${label || 'none'}`);
    } catch (e) {
      console.warn(`[AutopilotV3][FINAL RECIPE GUARD] 원문 재확인 실패 reason="${e.response?.data?.error?.message || e.message}"`);
    }
  }

  // 일반제품과 레시피 모두 최종 본문은 사람 반응 중심 문체로 한 번 통일한다
  // 기존 상품설명형 문체가 아니어도 최종 단계에서 다시 작성해 계정 전체의 결을 맞춘다
  result.text = await rewriteReactionPost(accountId, result, detail);
  result.text = sanitizeBody(result.text);
  return result;
};

console.log('[Autopilot][FINAL SANITY] 반응 중심 2~6줄 가변 본문 + 더라체 억제 + 기능설명 최소화 + 레시피 원문 재검증 활성화');
