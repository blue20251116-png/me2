const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v || '').trim(); }
function stripTerminalPeriods(text){
  return String(text || '').replace(/\r/g,'').split('\n').map(line => line.replace(/\.\s*$/g,'').trimEnd()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function getOpenAIKey(accountId){
  const a = getAccount(accountId), s = getSystemApiSettings();
  return s.openai_api_key || process.env.OPENAI_API_KEY || a?.openai_api_key || null;
}
function sourceContext(result){
  return [result?.sourceText,result?.sourceCaption,result?.originalText,result?.materialText,result?.text,result?.visionTarget?.dish,result?.visionTarget?.ingredient,result?.visionTarget?.promotedIngredient].map(clean).filter(Boolean).join('\n');
}
function importantSourceIngredients(result){
  const src = sourceContext(result);
  const known = ['계란','달걀','방울토마토','토마토','양송이버섯','버섯','시금치','식빵','빵','치즈','올리브유','올리브오일','소금','후추','대패삼겹살','삼겹살','숙주','부추','양파','감자','오이','소고기','새우','두부','당면','배추','김치','마늘','버터'];
  return known.filter(x => src.includes(x));
}
function recipeContainsIngredient(text, item){
  const aliases = {계란:['계란','달걀'],달걀:['계란','달걀'],양송이버섯:['양송이','버섯'],버섯:['버섯','양송이'],식빵:['식빵','빵'],빵:['식빵','빵'],올리브유:['올리브유','올리브오일'],올리브오일:['올리브유','올리브오일'],대패삼겹살:['대패삼겹살','삼겹살'],삼겹살:['삼겹살','대패삼겹살']};
  return (aliases[item] || [item]).some(x => String(text||'').includes(x));
}
function badRecipe(text, result){
  const t = clean(text);
  if (!/🥘\s*재료\s*\n/.test(t) || !/🍳\s*만드는 법\s*\n/.test(t)) return true;
  if (/(양념\s*재료들?|기본\s*재료|원문에\s*나온|적당량의\s*양념|알맞게\s*익혀|재료를\s*준비해)/i.test(t)) return true;
  const ingredient = (t.split(/🍳\s*만드는 법/)[0] || '').replace(/^.*?🥘\s*재료\s*/s, '');
  const method = (t.split(/🍳\s*만드는 법/)[1] || '');
  const concreteItems = ingredient.split(/\n|,/).map(x=>x.trim()).filter(x=>x && !/^[-•]?\s*(비밀 소스|비밀 재료)$/i.test(x));
  const steps = method.split(/\n/).filter(x=>/^\s*\d+[.)]/.test(x));
  if (concreteItems.length < 4 || steps.length < 3) return true;
  if (!/(\d+(?:\.\d+)?\s*(?:g|kg|ml|L|개|장|큰술|작은술|스푼|컵|T|t)|약간|적당량)/i.test(ingredient)) return true;
  const required = importantSourceIngredients(result);
  if (required.some(x => !recipeContainsIngredient(t, x))) return true;
  if (/비밀\s*(?:소스|재료)/.test(t) && !clean(result?.secretTerm) && !clean(result?.visionTarget?.promotedIngredient)) return true;
  return false;
}

async function rewriteRecipe(accountId, result){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const productName = clean(result?.product?.name);
  const src = sourceContext(result);
  const required = importantSourceIngredients(result);
  const secretCandidate = clean(result?.secretTerm) || clean(result?.visionTarget?.promotedIngredient);
  const prompt = `너는 Threads용 한국 가정식 레시피 편집자다. 원본 소재와 기존 댓글을 바탕으로 실제 영상/본문과 일치하는 짧고 완결된 레시피 댓글을 작성한다.\n\n절대 규칙:\n- 정확히 '🥘 재료' 다음 줄에 재료, 빈 줄 뒤 '🍳 만드는 법' 다음 줄에 조리법을 쓴다. '🍳 만드는 법1.'처럼 제목과 1번을 붙이지 않는다.\n- 원본 소재에서 명시적으로 등장한 핵심 재료는 절대 누락하지 않는다. 특히 본문에 치즈, 식빵, 계란, 토마토, 버섯, 시금치 등이 언급되면 모두 재료와 필요한 조리 단계에 반영한다.\n- 재료 목록과 만드는 법은 서로 일치해야 한다. 재료에 쓴 핵심 식재료는 조리 단계에서 사용하고, 조리 단계에서 쓰는 핵심 식재료는 재료 목록에도 있어야 한다.\n- 원본에 없는 비밀 소스나 비밀 재료를 억지로 만들지 않는다. 실제 제휴 후보가 있을 때만 그 재료 하나를 '비밀 소스' 또는 '비밀 재료'로 숨길 수 있다.\n- 원본에서 확인되지 않는 특이한 재료나 조리법을 임의로 추가하지 않는다. 다만 소금, 후추, 식용유처럼 일반적인 기본 조미료와 통상적인 1~2인분 계량은 자연스럽게 보완 가능하다.\n- 재료는 최소 4개, 가능한 1~2인분 기준 계량을 붙인다.\n- 만드는 법은 3~5단계로 짧고 자연스러운 반말로 쓴다. 존댓말과 음슴체 금지.\n- 일반 문장 끝 마침표(.)는 쓰지 않는다. 단 1. 2. 3. 단계 번호의 점은 유지한다.\n- 링크, 쿠팡 상품명, 브랜드명, 광고고지는 쓰지 않는다.\n- 전체는 링크 2개와 고지문이 뒤에 붙을 수 있도록 약 300자 이내로 쓴다.\nJSON만 출력: {"commentLead":""}`;
  const user = `[요리/주제]\n${clean(result.topic)}\n\n[원본 소재에서 확보한 텍스트/분석]\n${src}\n\n[반드시 보존할 핵심 재료]\n${required.join(', ') || '원본에 명시된 재료 전부'}\n\n[기존 댓글]\n${clean(result.commentLead)}\n\n[실제 제휴 후보]\n${secretCandidate || '없음 - 비밀 소스/비밀 재료를 만들지 말 것'}\n\n[현재 상품 - 참고만]\n${productName}`;
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model:'gpt-4o-mini', temperature:0.15, max_tokens:1200, response_format:{type:'json_object'},
    messages:[{role:'system',content:prompt},{role:'user',content:user}]
  }, {headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:45000});
  const raw = r.data?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(raw || '{}');
  return stripTerminalPeriods(clean(parsed.commentLead));
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, options){
  let last;
  for (let attempt=1; attempt<=3; attempt++) {
    const result = await originalBuild(accountId, options);
    if (result?.mode !== 'recipe') return result;
    last = result;
    if (!badRecipe(result.commentLead, result)) return {...result, commentLead:stripTerminalPeriods(result.commentLead)};
    const missing = importantSourceIngredients(result).filter(x => !recipeContainsIngredient(result.commentLead, x));
    console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 필요 missing="${missing.join(',')}" attempt=${attempt}/3`);
    try {
      const fixed = await rewriteRecipe(accountId, result);
      if (fixed && !badRecipe(fixed, result)) {
        console.log(`[AutopilotV3][RECIPE SOURCE CHECK] 원본 일치 검증 통과 length=${fixed.length}`);
        return {...result, commentLead: fixed};
      }
      console.warn('[AutopilotV3][RECIPE SOURCE CHECK] 재작성 결과도 원본 일치 기준 미달 → 새 소재 재시도');
    } catch (e) {
      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  throw new Error(`원본 소재와 일치하는 완결된 레시피를 생성하지 못했습니다: ${clean(last?.topic) || 'recipe'}`);
};

console.log('[Autopilot][RECIPE SOURCE CHECK] 원본 핵심재료 보존 + 재료/조리법 일치 + 가짜 비밀재료 금지 활성화');
