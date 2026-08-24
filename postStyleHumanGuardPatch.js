'use strict';

const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\s+\/\s+/g, '\n')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEALTH_TOPIC = /(?:유산균|프로바이오틱|영양제|건강기능식품|비타민|루테인|오메가|밀크씨슬|아르기닌|콜라겐|효소|홍삼|마그네슘|철분|칼슘|다이어트|혈당|장건강|간건강)/i;
const HEALTH_EFFECT = /(?:챙겨\s*먹기\s*시작|먹기\s*시작|먹고\s*나서|복용하고\s*나서|섭취하고\s*나서|화장실|배변|확실히\s*달라|효과\s*(?:봤|있|좋)|체감|몸이\s*(?:가벼|좋)|피로가\s*(?:줄|덜)|잠이\s*(?:잘|푹)|살이\s*빠|붓기가\s*빠)/i;
const RECIPE_CTA = /(?:재료(?:랑|와)?\s*(?:만드는\s*법|레시피)|만드는\s*법|레시피(?:는|가)?).*?(?:댓글|적어둘게|적어놨어)|(?:재료|만드는\s*법|레시피).*?댓글/i;
const CANNED = /(?:신세계|신의\s*한\s*수|활용도(?:도)?\s*높|완전\s*유용|간편하게\s*사용|실용적이야|삶의\s*질|강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워)/i;
const UNVERIFIED_USE = /(?:써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|샀는데|사줬는데|쓰고\s*나서|고민\s*없이\s*샀)/i;
const EUMSEUM = /(?:귀여움|멋짐|달라짐|폭발임|대박임|좋음|편함|유용함|했음|있음|없음|끝남|싶어짐|느껴짐|생각남|보임|유지됨|괜찮음|궁금해짐|꿀맛임)(?=$|\s|[!?~ㅋㅎ])/m;
// source grounding(원문 텍스트)이 이 최종 result 객체에 존재하지 않으므로(text/commentLead/product 등만 있음),
// 원문 대조는 불가능하다. 그래서 관계 단어 단독으로는 절대 매치되지 않게 하고,
// 반드시 "가상 구매/추천/사용" 또는 "관계인의 반응을 추측하는 speculative 서술"이 함께 있을 때만 제거 대상으로 삼는다.
const FABRICATED_RELATION = /(?:엄마|아빠|아내|와이프|남편|친구|애들|아이|직장\s*동료|동료)(?:가|는|한테|께서)?.{0,20}(?:추천해서|추천하길래|사줬는데|사왔|물어봤|하길래|쓰길래|써보라고|좋다고\s*(?:해서|하길래)|줬는데|먹어보라고|써보고|쫓겨나|눈치\s*(?:보이|줄)|잘\s*수\s*있을\s*듯|편할\s*듯|좋아할\s*듯|놀랄\s*듯)/;

function modeOf(result) { return String(result?.mode || result?.contentMode || result?.kind || '').toLowerCase(); }
function isRecipe(result) { return modeOf(result) === 'recipe'; }
function isHealth(result) { return HEALTH_TOPIC.test(`${result?.topic || ''} ${result?.product?.name || result?.product || ''} ${result?.productSearchTerm || ''}`); }

function lineRewrite(line) {
  return String(line || '')
    .replace(/귀여움/g,'귀여워').replace(/멋짐/g,'멋져').replace(/달라짐/g,'달라져')
    .replace(/대박임/g,'대박이야').replace(/좋음/g,'좋아').replace(/편함/g,'편해')
    .replace(/유용함/g,'쓸 만해').replace(/했음/g,'했어').replace(/있음/g,'있어').replace(/없음/g,'없어')
    .replace(/끝남/g,'끝나').replace(/싶어짐/g,'싶긴 해').replace(/느껴짐/g,'느껴져').replace(/생각남/g,'생각나').replace(/보임/g,'보여')
    .replace(/유지됨/g,'유지돼').replace(/괜찮음/g,'괜찮아').replace(/궁금해짐/g,'궁금해').replace(/꿀맛임/g,'꿀맛이야').replace(/폭발임/g,'폭발이야')
    .replace(/뭐냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'뭐지')
    .replace(/거냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'건가')
    .replace(/없냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'없나')
    .replace(/맞냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'맞나')
    .replace(/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워서\s*공유해/g,'')
    .trim();
}

// finalTextHardGuardPatch.js의 hasUnsafeNyaEnding()과 동일한 안전 원칙을 이 파일 안에서 독립적으로 적용한다.
// (파일 간 의존성을 새로 만들지 않기 위해 로직만 동일하게 복제)
function hasUnsafeNyaEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length) : raw;
  if (!/[가-힣]+냐$/.test(core)) return false;
  if (/(?:뭐냐|거냐|없냐|맞냐)$/.test(core)) return false;
  return true;
}

function sanitizeByBlocks(text, result) {
  const blocks = clean(text).split(/\n\n+/);
  const outBlocks = [];
  let total = 0;
  for (const block of blocks) {
    const out = [];
    for (let line of block.split('\n').map(x=>x.trim()).filter(Boolean)) {
      if (total >= 8) break;
      if (!isRecipe(result) && RECIPE_CTA.test(line)) continue;
      if (isHealth(result) && HEALTH_EFFECT.test(line)) continue;
      if (FABRICATED_RELATION.test(line)) continue;
      if (hasUnsafeNyaEnding(line)) continue;
      if (!isRecipe(result) && UNVERIFIED_USE.test(line)) line = line.replace(/써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|샀는데/g,'보니까').replace(/쓰고\s*나서/g,'보고 나서');
      line = lineRewrite(line);
      if (!line) continue;
      out.push(line);
      total++;
    }
    if (out.length) outBlocks.push(out);
    if (total >= 8) break;
  }
  return outBlocks.map(lines=>lines.join('\n')).join('\n\n').replace(/\n{3,}/g,'\n\n').trim();
}

function inspect(text, result) {
  const t = clean(text);
  const fatal = [];
  if (!isRecipe(result) && RECIPE_CTA.test(t)) fatal.push('wrong-recipe-cta');
  if (EUMSEUM.test(t)) fatal.push('eumseum');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) fatal.push('nya');
  if (CANNED.test(t)) fatal.push('canned-ad-tone');
  if (!isRecipe(result) && UNVERIFIED_USE.test(t)) fatal.push('unverified-use');
  if (FABRICATED_RELATION.test(t)) fatal.push('fabricated-relation');
  if (isHealth(result) && HEALTH_EFFECT.test(t)) fatal.push('health-effect');
  return [...new Set(fatal)];
}

engine.buildThreadsFirstAutopilot = async function postStyleHumanGuardBuild(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const text = sanitizeByBlocks(result.text, result);
  const remaining = inspect(text, result);
  console.log(`[AutopilotV3][POST STYLE GUARD v12] remaining=${remaining.length?remaining.join(','):'PASS'} preview="${text.slice(0,180).replace(/\n/g,' / ')}"`);
  if (remaining.length) throw new Error(`최종 Threads 문체 검사 실패: ${remaining.join(',')}`);
  return { ...result, text };
};

console.log('[AutopilotV3][POST STYLE GUARD] v12 EUMSEUM동기화 + 관계허구제거 + fail-closed');
module.exports = { clean, inspect, sanitizeByBlocks };
