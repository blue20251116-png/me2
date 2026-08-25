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
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const HEALTH_TOPIC = /(?:유산균|프로바이오틱|영양제|건강기능식품|비타민|루테인|오메가|밀크씨슬|아르기닌|콜라겐|효소|홍삼|마그네슘|철분|칼슘|다이어트|혈당|장건강|간건강)/i;
const HEALTH_EFFECT = /(?:챙겨\s*먹기\s*시작|먹기\s*시작|먹고\s*나서|복용하고\s*나서|섭취하고\s*나서|화장실|배변|확실히\s*달라|효과\s*(?:봤|있|좋)|체감|몸이\s*(?:가벼|좋)|피로가\s*(?:줄|덜)|잠이\s*(?:잘|푹)|살이\s*빠|붓기가\s*빠)/i;
const RECIPE_CTA = /(?:재료(?:랑|와)?\s*(?:만드는\s*법|레시피)|만드는\s*법|레시피(?:는|가)?).*?(?:댓글|적어둘게|적어놨어)|(?:재료|만드는\s*법|레시피).*?댓글/i;
const RECIPE_LEAK = /(?:비밀\s*(?:재료|소스)|🥘\s*재료|🍳\s*만드는\s*법)/i;
const CANNED = /(?:신세계|신의\s*한\s*수|활용도(?:도)?\s*높|완전\s*유용|간편하게\s*사용|실용적이야|삶의\s*질|강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워)/i;
const UNVERIFIED_USE = /(?:써봤는데|써보니까|써봤거든|사용해보니까|사용해봤|사봤는데|사봤거든|구매했는데|샀는데|먹어보니까|먹어봤는데|먹어봤거든|해봤는데|해봤거든|쓰고\s*나서|먹고\s*나서)/i;
const FABRICATED_RELATION = /(?:엄마|아빠|아내|와이프|남편|남친|여친|친구|지인|직장\s*동료|동료)(?:가|는|이|한테|께서)?.{0,30}(?:추천(?:해|했|하길|해서|해줘|해줬)|사줬|사왔|먹어보라고|써보라고)/i;
const PRODUCT_BENEFIT = /(?:간편|간단|쉽(?:네|다|어|고|게)|편하|안전|보호|튼튼|깔끔|좋(?:다|아|네|고)|유용|실용|효율|신경\s*안\s*써도|마음이\s*편|걱정\s*(?:없|덜)|잘\s*(?:되|돼|지워|막아|잡아))/i;
const REVIEWY_USE = /(?:간편하다고\s*하길래|쉽다고\s*하길래|좋다고\s*하길래|추천하길래).{0,24}(?:해봤|써봤|사봤|사용해봤)|(?:해봤는데|써봤는데|사용해봤는데).{0,20}(?:진짜|정말|확실히)?\s*(?:쉽|편|좋|간단)/i;

function modeOf(result) { return String(result?.mode || result?.contentMode || result?.kind || '').toLowerCase(); }
function isRecipe(result) { return modeOf(result) === 'recipe'; }
function isHealth(result) { return HEALTH_TOPIC.test(`${result?.topic || ''} ${result?.product?.name || result?.product || ''} ${result?.productSearchTerm || ''}`); }
function contentLines(text) { return clean(text).split('\n').map(x => x.trim()).filter(Boolean); }
function productBenefitCount(text) { return contentLines(text).reduce((n, line) => n + (PRODUCT_BENEFIT.test(line) ? 1 : 0), 0); }

function lineRewrite(line) {
  return String(line || '')
    .replace(/뭐냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'뭐지')
    .replace(/거냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'건가')
    .replace(/없냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'없나')
    .replace(/맞냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g,'맞나')
    .replace(/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워서\s*공유해/g,'')
    .trim();
}

function hasUnsafeNyaEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length) : raw;
  if (!/[가-힣]+냐$/.test(core)) return false;
  if (/(?:뭐냐|거냐|없냐|맞냐)$/.test(core)) return false;
  return true;
}

function sanitizeByBlocks(text, result) {
  const normalized = clean(text);
  const pieces = normalized.split(/(\n{2,3})/);
  const out = [];
  let total = 0;
  let benefitSeen = false;
  const maxLines = isRecipe(result) ? 12 : 4;

  for (const piece of pieces) {
    if (!piece) continue;
    if (/^\n{2,3}$/.test(piece)) {
      if (out.length && !/^\n/.test(out[out.length - 1])) out.push(piece);
      continue;
    }

    const kept = [];
    for (let line of piece.split('\n').map(x => x.trim()).filter(Boolean)) {
      if (total >= maxLines) break;
      if (!isRecipe(result) && (RECIPE_CTA.test(line) || RECIPE_LEAK.test(line))) continue;
      if (isHealth(result) && HEALTH_EFFECT.test(line)) continue;
      if (FABRICATED_RELATION.test(line)) continue;
      if (UNVERIFIED_USE.test(line)) continue;
      if (!isRecipe(result) && REVIEWY_USE.test(line)) continue;
      if (hasUnsafeNyaEnding(line)) continue;
      line = lineRewrite(line);
      if (!line) continue;
      if (!isRecipe(result) && PRODUCT_BENEFIT.test(line)) {
        if (benefitSeen) continue;
        benefitSeen = true;
      }
      kept.push(line);
      total++;
    }
    if (kept.length) out.push(kept.join('\n'));
    if (total >= maxLines) break;
  }

  return out.join('').replace(/\n{4,}/g, '\n\n\n').trim();
}

function inspect(text, result) {
  const t = clean(text);
  const fatal = [];
  if (!isRecipe(result) && (RECIPE_CTA.test(t) || RECIPE_LEAK.test(t))) fatal.push('recipe-leak');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) fatal.push('nya');
  if (CANNED.test(t)) fatal.push('canned-ad-tone');
  if (UNVERIFIED_USE.test(t)) fatal.push('unverified-use');
  if (FABRICATED_RELATION.test(t)) fatal.push('fabricated-relation');
  if (isHealth(result) && HEALTH_EFFECT.test(t)) fatal.push('health-effect');

  if (!isRecipe(result)) {
    const lines = contentLines(t);
    if (lines.length > 4) fatal.push('product-too-long');
    if (productBenefitCount(t) >= 2) fatal.push('benefit-stacking');
    if (REVIEWY_USE.test(t)) fatal.push('review-template');
  }
  return [...new Set(fatal)];
}

engine.buildThreadsFirstAutopilot = async function postStyleHumanGuardBuild(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const before = clean(result.text);
  const text = sanitizeByBlocks(before, result);
  const remaining = inspect(text, result);
  const changed = before !== text;
  console.log(`[AutopilotV3][POST STYLE GUARD v16] ${changed?'soft-repair=ON ':' '}remaining=${remaining.length?remaining.join(','):'PASS'} preview="${text.slice(0,180).replace(/\n/g,' / ')}"`);
  if (remaining.length) throw new Error(`최종 Threads 문체 검사 실패: ${remaining.join(',')}`);
  if (!text) throw new Error('최종 Threads 문체 검사 실패: empty-after-repair');
  return { ...result, text };
};

console.log('[AutopilotV3][POST STYLE GUARD] v16 soft repair first · benefit/review/recipe-leak 제거 후 hard fail');
module.exports = { clean, inspect, sanitizeByBlocks, productBenefitCount };
