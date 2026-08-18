const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v || '').trim(); }
function getOpenAIKey(accountId){
  const a = getAccount(accountId), s = getSystemApiSettings();
  return s.openai_api_key || process.env.OPENAI_API_KEY || a?.openai_api_key || null;
}
function badRecipe(text){
  const t = clean(text);
  if (!/🥘\s*재료/.test(t) || !/🍳\s*만드는 법/.test(t)) return true;
  if (/(양념\s*재료들?|기본\s*재료|원문에\s*나온|적당량의\s*양념|알맞게\s*익혀|재료를\s*준비해)/i.test(t)) return true;
  const ingredient = (t.split(/🍳\s*만드는 법/)[0] || '').replace(/^.*?🥘\s*재료\s*/s, '');
  const method = (t.split(/🍳\s*만드는 법/)[1] || '');
  const concreteItems = ingredient.split(/\n|,/).map(x=>x.trim()).filter(x=>x && !/^[-•]?\s*(비밀 소스|비밀 재료)$/i.test(x));
  const steps = method.split(/\n/).filter(x=>/^\s*\d+[.)]/.test(x));
  if (concreteItems.length < 3 || steps.length < 3) return true;
  if (!/(\d+(?:\.\d+)?\s*(?:g|kg|ml|L|개|장|큰술|작은술|스푼|컵|T|t)|약간|적당량)/i.test(ingredient)) return true;
  return false;
}

async function rewriteRecipe(accountId, result){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const productName = clean(result?.product?.name);
  const prompt = `너는 한국 가정식 레시피 편집자다. 아래 요리와 기존 댓글을 바탕으로 실제로 따라 만들 수 있는 짧고 완결된 레시피 댓글을 다시 작성한다.\n\n필수 규칙:\n- 정확히 '🥘 재료'와 '🍳 만드는 법' 두 섹션을 사용한다. 제목 바로 다음 줄부터 내용을 쓴다.\n- '양념 재료들', '기본 재료', '원문에 나온 재료', '적당히 조리' 같은 뭉뚱그린 표현은 절대 금지한다.\n- 재료는 최소 4개를 구체적인 이름으로 쓴다. 가능한 일반적인 1~2인분 기준 계량(g, 개, 장, 큰술, 작은술 등)을 붙인다.\n- 쿠팡 연결 대상 하나만 정확한 상품명 대신 '비밀 소스' 또는 '비밀 재료'라고 쓴다. 나머지 재료와 양념은 숨기지 않는다.\n- 만드는 법은 3~5단계, 각 단계는 짧고 자연스러운 반말로 쓴다.\n- 존댓말과 음슴체 금지.\n- 링크, 쿠팡 상품명, 브랜드명, 광고고지는 쓰지 않는다.\n- 전체는 링크가 뒤에 붙을 수 있도록 최대 300자 안팎으로 간결하게 쓴다.\n- 기존 댓글에 구체적 계량이 없으면 해당 요리의 통상적인 1~2인분 기준으로 현실적인 계량을 보완한다. 과도하게 정밀한 수치는 만들지 않는다.\nJSON만 출력: {"commentLead":""}`;
  const user = `[요리/주제]\n${clean(result.topic)}\n\n[기존 댓글]\n${clean(result.commentLead)}\n\n[내부 제휴 대상 - 정확한 이름 출력 금지]\n${clean(result.secretTerm) || productName}`;
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model:'gpt-4o-mini', temperature:0.25, max_tokens:1200, response_format:{type:'json_object'},
    messages:[{role:'system',content:prompt},{role:'user',content:user}]
  }, {headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:45000});
  const raw = r.data?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(raw || '{}');
  return clean(parsed.commentLead);
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, options){
  let last;
  for (let attempt=1; attempt<=3; attempt++) {
    const result = await originalBuild(accountId, options);
    if (result?.mode !== 'recipe') return result;
    last = result;
    if (!badRecipe(result.commentLead)) return result;
    console.warn(`[AutopilotV3][RECIPE QUALITY] 부실 레시피 감지 → 구체적 재료/계량/조리법 재작성 attempt=${attempt}/3`);
    try {
      const fixed = await rewriteRecipe(accountId, result);
      if (fixed && !badRecipe(fixed)) {
        console.log(`[AutopilotV3][RECIPE QUALITY] 재작성 통과 length=${fixed.length}`);
        return {...result, commentLead: fixed};
      }
      console.warn('[AutopilotV3][RECIPE QUALITY] 재작성 결과도 기준 미달 → 새 소재 재시도');
    } catch (e) {
      console.warn(`[AutopilotV3][RECIPE QUALITY] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  throw new Error(`구체적인 재료·계량·만드는 법을 갖춘 레시피를 생성하지 못했습니다: ${clean(last?.topic) || 'recipe'}`);
};

console.log('[Autopilot][RECIPE QUALITY] 구체적 재료+계량+3단계 이상 조리법 강제 활성화');
