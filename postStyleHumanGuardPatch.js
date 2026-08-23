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
    .split('\n').map(x => x.trim()).filter(Boolean).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const REACTION = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|ㅠㅠ+|ㅜㅜ+|😆|😂|🤣|🔥|헐|존맛탱|개맛|미쳤)/gi;
const HEALTH_TOPIC = /(?:유산균|프로바이오틱|영양제|건강기능식품|비타민|루테인|오메가|밀크씨슬|아르기닌|콜라겐|효소|홍삼|마그네슘|철분|칼슘|다이어트|혈당|장건강|간건강)/i;
const HEALTH_EFFECT = /(?:챙겨\s*먹기\s*시작|먹기\s*시작|먹고\s*나서|복용하고\s*나서|섭취하고\s*나서|화장실|배변|확실히\s*달라|효과\s*(?:봤|있|좋)|체감|몸이\s*(?:가벼|좋)|피로가\s*(?:줄|덜)|잠이\s*(?:잘|푹)|살이\s*빠|붓기가\s*빠)/i;
const RECIPE_CTA = /(?:재료(?:랑|와)?\s*(?:만드는\s*법|레시피)|만드는\s*법|레시피(?:는|가)?).*?(?:댓글|적어둘게|적어놨어)|(?:재료|만드는\s*법|레시피).*?댓글/i;
// 짧은 인간 감탄은 허용한다. 차단 대상은 광고/후기 상투어와 과장 총평이다.
const CANNED = /(?:신세계|신의\s*한\s*수|활용도(?:도)?\s*높|완전\s*유용|스트레스가\s*확\s*줄|완전\s*다른\s*세상|간편하게\s*사용|실용적이야|삶의\s*질|강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회)/i;
const UNVERIFIED_USE = /(?:바꿨는데|써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|쓰니까|쓰고\s*나서|샀는데)/i;

function modeOf(result) { return String(result?.mode || result?.contentMode || result?.kind || '').toLowerCase(); }
function isRecipe(result) { return modeOf(result) === 'recipe'; }
function isHealth(result) { return HEALTH_TOPIC.test(`${result?.topic || ''} ${result?.product?.name || result?.product || ''} ${result?.productSearchTerm || ''}`); }

function inspect(text, result) {
  const t = clean(text);
  const reasons = [];
  if (!isRecipe(result) && RECIPE_CTA.test(t)) reasons.push('wrong-recipe-cta');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|끝남|싶어짐|느껴짐|생각남|보임|유용함)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('eumseum');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya');
  if (CANNED.test(t)) reasons.push('canned-ad-tone');
  if (!isRecipe(result) && UNVERIFIED_USE.test(t)) reasons.push('unverified-use');
  if (isHealth(result) && HEALTH_EFFECT.test(t)) reasons.push('health-effect');
  if (t.split('\n').some(x => x.length > 38)) reasons.push('long-line');
  const reactions = t.match(REACTION) || [];
  if (reactions.length > 3) reasons.push('reaction-overuse');
  return [...new Set(reasons)];
}

function stripWrongCta(text, result) {
  if (isRecipe(result)) return text;
  return clean(clean(text).split('\n').filter(x => !RECIPE_CTA.test(x)).join('\n'));
}
function stripHealth(text, result) {
  if (!isHealth(result)) return text;
  return clean(clean(text).split('\n').filter(x => !HEALTH_EFFECT.test(x)).join('\n'));
}

function rewriteLine(line, result) {
  let s = String(line || '').trim();
  if (!isRecipe(result)) {
    s = s
      .replace(/([가-힣A-Za-z0-9 ]+?)\s*바꿨는데/g, '$1 보니까')
      .replace(/써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|샀는데/g, '보니까')
      .replace(/쓰니까/g, '보면');
  }
  s = s
    // 짧은 감탄은 살린다: 와 이거 대박이야ㅋㅋ / 이거 진짜 미쳤다ㅋㅋ / 아니 이거 뭐야ㅋㅋ
    .replace(/이거\s*진짜\s*신세계다?/g, '와 이거 좀 신기한데ㅋㅋ')
    .replace(/신세계(?:다|야|임)?/g, '이건 좀 신기하네')
    .replace(/신의\s*한\s*수(?:임|야)?/g, '이건 좀 괜찮네')
    .replace(/진작\s*알았으면\s*좋았을\s*텐데/g, '이런 방식도 있네')
    .replace(/완전\s*유용(?:함|해)?/g, '이건 좀 쓸 만해')
    .replace(/유용함/g, '쓸 만해')
    .replace(/싶어짐/g, '싶긴 해')
    .replace(/느껴짐/g, '느껴져')
    .replace(/좋음/g, '좋아')
    .replace(/편함/g, '편해')
    .replace(/있음/g, '있어')
    .replace(/없음/g, '없어')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나')
    .replace(/활용도(?:도)?\s*높[^!?\n]*/g, '')
    .replace(/스트레스가\s*확\s*줄[^!?\n]*/g, '')
    .replace(/삶의\s*질[^!?\n]*/g, '')
    .replace(/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회/g, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function splitLines(text) {
  const out = [];
  for (let line of clean(text).split('\n').filter(Boolean)) {
    while (line.length > 38) {
      const anchors = [' 근데 ', ' 그래서 ', ' 이건 ', ' 그냥 ', ' 붙이', ' 보면 ', ' ㅋㅋ ', ' 댓글', ' 생각보다 '];
      let cut = -1;
      for (const a of anchors) {
        const p = line.lastIndexOf(a, 38);
        if (p >= 12) cut = Math.max(cut, p);
      }
      if (cut < 12) cut = line.lastIndexOf(' ', 38);
      if (cut < 12) break;
      out.push(line.slice(0, cut).trim());
      line = line.slice(cut).trim();
    }
    if (line) out.push(line);
  }
  return out.filter(x => x.length > 1).slice(0, 7).join('\n');
}

function addThreadsRhythm(text, result) {
  let lines = clean(text).split('\n').filter(Boolean);
  if (!lines.length) return '';
  const joined = lines.join(' ');
  const native = /(?:스치니|치니들|ㅋㅋ|ㅠㅠ|ㅁㅊ|ㄷㄷ|아니\s*근데|이건\s*좀|은근|대박|미쳤|뭐야)/.test(joined);
  const key = `${result?.sourceUrl || result?.source || ''}|${result?.topic || ''}|${result?.accountId || ''}`;
  let h = 0;
  for (const ch of key) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  const bucket = Math.abs(h) % 10;
  if (!native) {
    // 약 절반은 사람 같은 즉흥 첫 반응을 허용하고 나머지는 원래 장면/생활 시작을 유지한다.
    if (bucket === 0) lines[0] = `와 이거 대박이야ㅋㅋ\n${lines[0]}`;
    else if (bucket === 1) lines[0] = `이거 진짜 미쳤다ㅋㅋ\n${lines[0]}`;
    else if (bucket === 2) lines[0] = `아니 이거 뭐야ㅋㅋ\n${lines[0]}`;
    else if (bucket === 3) lines[0] = `와 이런 게 있었네ㅋㅋ\n${lines[0]}`;
    else if (bucket === 4) lines[0] = `아니 근데 이건 좀 괜찮다\n${lines[0]}`;
    else if (bucket === 5) lines.push('이거 아는 스치니 있어?');
  }
  return clean(lines.join('\n'));
}

function finalize(text, result) {
  let t = clean(text);
  t = stripWrongCta(t, result);
  t = stripHealth(t, result);
  for (let i = 0; i < 3; i++) {
    t = t.split('\n').map(x => rewriteLine(x, result)).filter(Boolean).join('\n');
    t = splitLines(t);
    let count = 0;
    t = t.replace(REACTION, m => (++count <= 3 ? m : ''));
    if (!inspect(t, result).length) break;
  }
  t = addThreadsRhythm(t, result);
  t = splitLines(t);
  return clean(t);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const before = clean(result.text);
  const reasons = inspect(before, result);
  const fixed = finalize(before, result);
  const remaining = inspect(fixed, result);
  console.log(`[AutopilotV3][POST STYLE GUARD v6] mode=${modeOf(result)||'-'} reasons=${reasons.join(',')||'none'} remaining=${remaining.join(',')||'PASS'} preview="${fixed.slice(0,180).replace(/\n/g,' / ')}"`);
  return { ...result, text: fixed };
};

console.log('[AutopilotV3][POST STYLE GUARD] v6 인간적인 강한 감탄 유지 + 광고상투어/가짜경험/잘못된CTA 제거 + Threads 피드호흡 · AI추가호출 없음');
module.exports = { inspect, clean, finalize };
