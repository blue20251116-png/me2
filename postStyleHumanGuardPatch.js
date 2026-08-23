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
const CANNED = /(?:신세계|신의\s*한\s*수|활용도(?:도)?\s*높|완전\s*유용|스트레스가\s*확\s*줄|완전\s*다른\s*세상|간편하게\s*사용|실용적이야|삶의\s*질|강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워)/i;
const UNVERIFIED_USE = /(?:바꿨는데|써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|쓰니까|쓰고\s*나서|샀는데|고민\s*없이\s*샀|들고\s*나가야겠|찾다가\s*이거\s*발견)/i;
const EUMSEUM = /(?:귀여움|멋짐|달라짐|폭발임|대박임|좋음|편함|유용함|했음|있음|없음|끝남|싶어짐|느껴짐|생각남|보임)(?=$|\s|[!?~ㅋㅎ])/m;
const FATAL_REASONS = new Set(['wrong-recipe-cta','eumseum','nya','canned-ad-tone','unverified-use','health-effect','dangling-reaction']);

function modeOf(result) { return String(result?.mode || result?.contentMode || result?.kind || '').toLowerCase(); }
function isRecipe(result) { return modeOf(result) === 'recipe'; }
function isHealth(result) { return HEALTH_TOPIC.test(`${result?.topic || ''} ${result?.product?.name || result?.product || ''} ${result?.productSearchTerm || ''}`); }

function inspect(text, result) {
  const t = clean(text);
  const reasons = [];
  if (!isRecipe(result) && RECIPE_CTA.test(t)) reasons.push('wrong-recipe-cta');
  if (EUMSEUM.test(t)) reasons.push('eumseum');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya');
  if (CANNED.test(t)) reasons.push('canned-ad-tone');
  if (!isRecipe(result) && UNVERIFIED_USE.test(t)) reasons.push('unverified-use');
  if (isHealth(result) && HEALTH_EFFECT.test(t)) reasons.push('health-effect');
  if (t.split('\n').some(x => x.length > 58)) reasons.push('long-line');
  const reactions = t.match(REACTION) || [];
  if (reactions.length > 3) reasons.push('reaction-overuse');
  if (/^(?:ㅋㅋ+|ㅎㅎ+|ㅠㅠ+|ㅜㅜ+)\s+/m.test(t)) reasons.push('dangling-reaction');
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
      .replace(/찾다가\s*이거\s*발견했어/g, '이거 보자마자 눈에 들어왔어')
      .replace(/([가-힣A-Za-z0-9 ]+?)\s*바꿨는데/g, '$1 보니까')
      .replace(/써봤는데|써보니까|사용해보니까|사봤는데|구매했는데|샀는데/g, '보니까')
      .replace(/쓰니까/g, '보면')
      .replace(/가격도\s*괜찮아서\s*고민\s*없이\s*샀어/g, '')
      .replace(/이제\s*외출할\s*때마다\s*이\s*가방\s*들고\s*나가야겠다/g, '')
      .replace(/고민\s*없이\s*샀어/g, '')
      .replace(/들고\s*나가야겠다/g, '외출할 때 눈에 띄긴 하겠다');
  }

  s = s
    .replace(/귀여움/g, '귀여워')
    .replace(/멋짐/g, '멋져')
    .replace(/완전\s*달라짐/g, '완전 달라져')
    .replace(/달라짐/g, '달라져')
    .replace(/감성\s*폭발임/g, '감성 제대로네ㅋㅋ')
    .replace(/폭발임/g, '제대로네ㅋㅋ')
    .replace(/대박임/g, '대박이야')
    .replace(/좋음/g, '좋아')
    .replace(/편함/g, '편해')
    .replace(/유용함/g, '쓸 만해')
    .replace(/했음/g, '했어')
    .replace(/있음/g, '있어')
    .replace(/없음/g, '없어')
    .replace(/끝남/g, '끝나')
    .replace(/싶어짐/g, '싶긴 해')
    .replace(/느껴짐/g, '느껴져')
    .replace(/생각남/g, '생각나')
    .replace(/보임/g, '보여')
    .replace(/이거\s*진짜\s*신세계다?/g, '와 이거 좀 신기한데ㅋㅋ')
    .replace(/신세계(?:다|야|임)?/g, '이건 좀 신기하네')
    .replace(/신의\s*한\s*수(?:임|야)?/g, '이건 좀 괜찮네')
    .replace(/진작\s*알았으면\s*좋았을\s*텐데/g, '이런 방식도 있네')
    .replace(/완전\s*유용(?:함|해)?/g, '이건 좀 쓸 만해')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나')
    .replace(/활용도(?:도)?\s*높[^!?\n]*/g, '')
    .replace(/스트레스가\s*확\s*줄[^!?\n]*/g, '')
    .replace(/삶의\s*질[^!?\n]*/g, '')
    .replace(/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회|나만\s*알기\s*아까워서\s*공유해/g, '')
    .replace(/답답함도\s*없어서\s*강아지한테도\s*좋을\s*듯/g, '얼굴이 빼꼼 나오는 구조네')
    .replace(/다음\s*집들이\s*선물로\s*완전\s*좋을\s*듯/g, '선물용으로도 눈에 띄긴 하겠다');

  return s.replace(/\s{2,}/g, ' ').trim();
}

function mergeDanglingReactions(lines) {
  const out = [];
  for (let line of lines) {
    const m = line.match(/^(ㅋㅋ+|ㅎㅎ+|ㅠㅠ+|ㅜㅜ+)\s*(.*)$/);
    if (m && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${m[1]}`.trim();
      if (m[2]) out.push(m[2].trim());
    } else out.push(line);
  }
  return out;
}

function splitLines(text) {
  const source = clean(text).split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  const SAFE_ANCHORS = [' 근데 ', ' 그래서 ', ' 아니 ', ' 이건 ', ' 그냥 ', ' 보면 ', ' 생각보다 ', ' 댓글에 ', ' 재료랑 ', ' 만드는 법', ' ㅋㅋ '];
  for (let line of source) {
    if (line.length <= 58) { out.push(line); continue; }
    let rest = line;
    while (rest.length > 58) {
      let cut = -1;
      for (const anchor of SAFE_ANCHORS) {
        const p = rest.lastIndexOf(anchor, 58);
        if (p >= 18) cut = Math.max(cut, p);
      }
      if (cut < 18) break;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return mergeDanglingReactions(out).filter(x => x.length > 1).slice(0, 7).join('\n');
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
    if (bucket === 0) lines.unshift('와 이거 대박이야ㅋㅋ');
    else if (bucket === 1) lines.unshift('이거 진짜 미쳤다ㅋㅋ');
    else if (bucket === 2) lines.unshift('아니 이거 뭐야ㅋㅋ');
    else if (bucket === 3) lines.unshift('와 이런 게 있었네ㅋㅋ');
    else if (bucket === 4) lines.unshift('아니 근데 이건 좀 괜찮다');
    else if (bucket === 5) lines.push('이거 아는 스치니 있어?');
  }
  return clean(lines.join('\n'));
}

function finalize(text, result) {
  let t = clean(text);
  t = stripWrongCta(t, result);
  t = stripHealth(t, result);
  for (let pass = 0; pass < 3; pass++) {
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

function enforceFatalPass(text, result) {
  let t = clean(text);
  for (let pass = 0; pass < 3; pass++) {
    t = stripWrongCta(t, result);
    t = stripHealth(t, result);
    t = t.split('\n').map(x => rewriteLine(x, result)).filter(Boolean).join('\n');
    t = splitLines(t);
    const fatal = inspect(t, result).filter(r => FATAL_REASONS.has(r));
    if (!fatal.length) return clean(t);
  }

  // 최후 방어: 치환으로도 해결되지 않은 위험 줄만 제거한다.
  const kept = clean(t).split('\n').filter(line => {
    if (!isRecipe(result) && RECIPE_CTA.test(line)) return false;
    if (EUMSEUM.test(line)) return false;
    if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(line)) return false;
    if (CANNED.test(line)) return false;
    if (!isRecipe(result) && UNVERIFIED_USE.test(line)) return false;
    if (isHealth(result) && HEALTH_EFFECT.test(line)) return false;
    if (/^(?:ㅋㅋ+|ㅎㅎ+|ㅠㅠ+|ㅜㅜ+)\s+/.test(line)) return false;
    return true;
  });
  return clean(kept.join('\n'));
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const before = clean(result.text);
  const reasons = inspect(before, result);
  let fixed = finalize(before, result);
  fixed = enforceFatalPass(fixed, result);
  const remaining = inspect(fixed, result);
  const fatalRemaining = remaining.filter(r => FATAL_REASONS.has(r));
  console.log(`[AutopilotV3][POST STYLE GUARD v8] mode=${modeOf(result)||'-'} reasons=${reasons.join(',')||'none'} remaining=${remaining.join(',')||'PASS'} fatal=${fatalRemaining.join(',')||'PASS'} preview="${fixed.slice(0,220).replace(/\n/g,' / ')}"`);
  if (fatalRemaining.length) {
    throw new Error(`최종 Threads 문체 검사 실패: ${fatalRemaining.join(',')}`);
  }
  return { ...result, text: fixed };
};

console.log('[AutopilotV3][POST STYLE GUARD] v8 최종 fail-closed · 음슴체/가짜경험/잘못된CTA/건강효과 잔존 시 예약 차단 · 강한 Threads 반응 유지 · AI추가호출 없음');
module.exports = { inspect, clean, finalize, enforceFatalPass };
