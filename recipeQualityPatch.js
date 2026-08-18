const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);
const MAX_MATERIAL_ATTEMPTS = 6;

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
function recipeIssues(text, result){
  const t = clean(text), issues=[];
  if (!/🥘\s*재료\s*\n/.test(t)) issues.push('재료섹션');
  if (!/🍳\s*만드는 법\s*\n/.test(t)) issues.push('조리섹션');
  if (/(양념\s*재료들?|기본\s*재료|원문에\s*나온|적당량의\s*양념|알맞게\s*익혀|재료를\s*준비해)/i.test(t)) issues.push('모호한표현');
  const ingredient = (t.split(/🍳\s*만드는 법/)[0] || '').replace(/^.*?🥘\s*재료\s*/s, '');
  const method = (t.split(/🍳\s*만드는 법/)[1] || '');
  const concreteItems = ingredient.split(/\n|,/).map(x=>x.trim()).filter(x=>x && !/^[-•]?\s*(비밀 소스|비밀 재료)$/i.test(x));
  const steps = method.split(/\n/).filter(x=>/^\s*\d+[.)]/.test(x));
  // 발행률을 위해 형식 기준은 완화: 구체 재료 3개 + 조리 2단계면 허용.
  if (concreteItems.length < 3) issues.push('재료부족');
  if (steps.length < 2) issues.push('단계부족');
  const required = importantSourceIngredients(result);
  const missing = required.filter(x => !recipeContainsIngredient(t, x));
  if (missing.length) issues.push(`핵심재료누락:${missing.join(',')}`);
  // 가짜 비밀재료는 계속 강하게 차단.
  if (/비밀\s*(?:소스|재료)/.test(t) && !clean(result?.secretTerm) && !clean(result?.visionTarget?.promotedIngredient)) issues.push('가짜비밀재료');
  return issues;
}
function badRecipe(text,result){ return recipeIssues(text,result).length>0; }

async function rewriteRecipe(accountId, result){
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const productName = clean(result?.product?.name);
  const src = sourceContext(result);
  const required = importantSourceIngredients(result);
  const secretCandidate = clean(result?.secretTerm) || clean(result?.visionTarget?.promotedIngredient);
  const prompt = `너는 Threads용 한국 가정식 레시피 편집자다. 원본 소재와 기존 댓글을 바탕으로 실제 영상/본문과 일치하는 짧고 완결된 레시피 댓글을 작성한다.\n\n절대 규칙:\n- 정확히 '🥘 재료' 다음 줄에 재료, 빈 줄 뒤 '🍳 만드는 법' 다음 줄에 조리법을 쓴다.\n- 원본에 명시된 핵심 재료는 누락하지 않는다.\n- 원본에 없는 비밀 소스나 비밀 재료를 만들지 않는다. 실제 제휴 후보가 있을 때만 하나를 '비밀 소스' 또는 '비밀 재료'라고 숨긴다.\n- 원본에서 확인되지 않는 특이한 재료/조리법은 추가하지 않는다. 소금, 후추, 식용유 같은 기본 조미료는 자연스럽게 보완 가능하다.\n- 재료는 최소 3개, 만드는 법은 최소 2단계로 실제 따라할 수 있게 쓴다.\n- 짧고 자연스러운 반말. 존댓말과 음슴체 금지.\n- 일반 문장 끝 마침표(.)는 쓰지 않는다. 단계 번호의 점은 유지한다.\n- 링크, 쿠팡 상품명, 브랜드명, 광고고지는 쓰지 않는다.\n- 전체는 링크 2개와 고지문이 뒤에 붙을 수 있도록 약 300자 이내로 쓴다.\nJSON만 출력: {"commentLead":""}`;
  const user = `[요리/주제]\n${clean(result.topic)}\n\n[원본 소재]\n${src}\n\n[반드시 보존할 핵심 재료]\n${required.join(', ') || '원본에 명시된 재료'}\n\n[기존 댓글]\n${clean(result.commentLead)}\n\n[실제 제휴 후보]\n${secretCandidate || '없음 - 비밀 소스/비밀 재료를 만들지 말 것'}\n\n[현재 상품 - 참고만]\n${productName}`;
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
  for (let attempt=1; attempt<=MAX_MATERIAL_ATTEMPTS; attempt++) {
    const result = await originalBuild(accountId, options);
    if (result?.mode !== 'recipe') return result;
    last = result;
    const initialIssues=recipeIssues(result.commentLead,result);
    if (!initialIssues.length) return {...result, commentLead:stripTerminalPeriods(result.commentLead)};
    console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 필요 issues="${initialIssues.join('|')}" attempt=${attempt}/${MAX_MATERIAL_ATTEMPTS}`);
    try {
      const fixed = await rewriteRecipe(accountId, result);
      const fixedIssues=recipeIssues(fixed,result);
      if (fixed && !fixedIssues.length) {
        console.log(`[AutopilotV3][RECIPE SOURCE CHECK] 원본 핵심검증 통과 length=${fixed.length}`);
        return {...result, commentLead: fixed};
      }
      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 후 핵심기준 미달 issues="${fixedIssues.join('|')}" → 새 소재 재시도`);
    } catch (e) {
      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  throw new Error(`원본 핵심을 보존한 레시피를 ${MAX_MATERIAL_ATTEMPTS}개 소재에서 생성하지 못했습니다: ${clean(last?.topic) || 'recipe'}`);
};

console.log(`[Autopilot][RECIPE SOURCE CHECK] 핵심재료/가짜비밀재료 보호 유지 + 형식 완화 + 소재 최대 ${MAX_MATERIAL_ATTEMPTS}회 재시도 활성화`);
