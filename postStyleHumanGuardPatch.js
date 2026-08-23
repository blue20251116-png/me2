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

const REL = '(?:친구|남편|아내|시어머니|언니|오빠|동생|엄마|아빠|딸|아들|지인|주변\\s*사람)';
const REACTION_TOKEN = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|ㅠㅠ+|ㅜㅜ+|😆|😂|🤣|🔥|헐|존맛탱|개맛|미쳤)/gi;
const HEALTH_TOPIC = /(?:유산균|프로바이오틱|영양제|건강기능식품|비타민|루테인|오메가|밀크씨슬|아르기닌|콜라겐|효소|홍삼|마그네슘|철분|칼슘|다이어트|혈당|장건강|간건강)/i;
const HEALTH_EFFECT = /(?:챙겨\s*먹기\s*시작|먹기\s*시작|먹고\s*나서|복용하고\s*나서|섭취하고\s*나서|화장실\s*(?:가는|가게|잘|편)|배변|장이\s*(?:편|좋|가벼|힘들)|속이\s*(?:편|좋|가벼)|확실히\s*달라|효과\s*(?:봤|있|좋)|체감|몸이\s*(?:가벼|좋)|피로가\s*(?:줄|덜)|잠이\s*(?:잘|푹)|살이\s*빠|붓기가\s*빠|성취감으로\s*느껴)/i;
const RECIPE_CTA = /(?:재료(?:랑|와)?\s*(?:만드는\s*법|레시피)|만드는\s*법|레시피(?:는|가)?).*?(?:댓글|적어둘게|적어놨어)|(?:재료|만드는\s*법|레시피).*?댓글/gi;

function modeOf(result) {
  return String(result?.mode || result?.contentMode || result?.kind || '').toLowerCase();
}
function isRecipeResult(result) { return modeOf(result) === 'recipe'; }
function isHealthResult(result) {
  return HEALTH_TOPIC.test(`${result?.topic || ''} ${result?.product?.name || result?.product || ''} ${result?.productSearchTerm || ''}`);
}

function inspect(text, { health=false, recipe=false } = {}) {
  const t = clean(text);
  const reasons = [];
  if (/(?:활용도(?:도)?\s*높|진짜\s*편리|완전\s*좋|스트레스가\s*확\s*줄|완전\s*다른\s*세상|진입장벽이\s*낮|나만의\s*스타일|재밌을\s*것\s*같|해보고\s*싶어|왜\s*이렇게\s*쉽게\s*느껴|완전\s*유용)/i.test(t)) reasons.push('ai-review-tone');
  if (new RegExp(`(?:우리\\s*)?${REL}.{0,55}(?:행복|좋아|먹|쓰|샀|추천|말했|물어|난리|반응|손이\\s*가|비웠)`, 'i').test(t)) reasons.push('invented-relation');
  if (/(?:나도\s*(?:해봤|먹어봤|써봤|사봤)|집들이\s*때|반찬으로\s*내놓으니까|어디서\s*샀냐고|밥\s*두\s*(?:공기|그릇)|한눈팔\s*수\s*있)/i.test(t)) reasons.push('invented-experience');
  if (health && HEALTH_EFFECT.test(t)) reasons.push('health-effect-experience');
  if (!recipe && RECIPE_CTA.test(t)) reasons.push('wrong-recipe-cta');
  RECIPE_CTA.lastIndex = 0;
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|끝남|싶어짐|느껴짐|생각남|보임|유용함)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('eumseum');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya');
  if (t.split('\n').some(x => x.length > 42)) reasons.push('long-line');
  const reactions = t.match(REACTION_TOKEN) || [];
  if (reactions.length > 2) reasons.push('reaction-overuse');
  return [...new Set(reasons)];
}

function humanizeLine(line) {
  let s = String(line || '').trim();
  s = s
    .replace(/해보고\s*싶어짐/g, '한번 해보고 싶긴 해')
    .replace(/먹어보고\s*싶어짐/g, '한번 먹어보고 싶긴 해')
    .replace(/사고\s*싶어짐/g, '좀 눈이 가긴 해')
    .replace(/좋아짐/g, '좋아져')
    .replace(/편해짐/g, '편해져')
    .replace(/느껴짐/g, '느껴져')
    .replace(/생각남/g, '생각나')
    .replace(/보임/g, '보여')
    .replace(/유용함/g, '쓸 만해')
    .replace(/완전\s*유용(?:해|함)/g, '이건 좀 쓸 만해')
    .replace(/완전\s*다른\s*세상/g, '생각했던 거랑 좀 다르네')
    .replace(/진짜\s*편리해/g, '이건 좀 편하겠다')
    .replace(/활용도(?:도)?\s*높[^!?\n]*/g, '')
    .replace(/공간\s*활용도\s*좋고/g, '자리 바꾸기 쉽고')
    .replace(/스트레스가\s*확\s*줄[^!?\n]*/g, '')
    .replace(/진입장벽이\s*낮[^!?\n]*/g, '생각보다 어렵진 않아 보여')
    .replace(/왜\s*이렇게\s*쉽게\s*느껴지지\??/g, '생각보다 간단해 보이네')
    .replace(/완전\s*귀엽고/g, '은근 괜찮고')
    .replace(/나만의\s*스타일로\s*만들고\s*싶어져/g, '원하는 문구로 만들 수 있네')
    .replace(/만들면\s*진짜\s*재밌을\s*것\s*같아!?/g, '이런 건 한번 만들어보고 싶긴 해')
    .replace(/진짜\s*쉬운\s*것\s*같아/g, '생각보다 간단해 보이네')
    .replace(/완전\s*좋아!?/g, '')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function removeInvented(text) {
  let t = text;
  const relRe = new RegExp(`(?:우리\\s*)?${REL}[^!?\\n]{0,70}(?:밥\\s*두\\s*(?:공기|그릇)[^!?\\n]*|계속\\s*손이\\s*가[^!?\\n]*|어디서\\s*샀냐고[^!?\\n]*|반응이\\s*미쳤[^!?\\n]*|난리[^!?\\n]*|좋아(?:했|하)[^!?\\n]*)`, 'gi');
  t = t.replace(relRe, '');
  t = t.replace(/집들이\s*때[^!?\n]{0,70}/gi, '');
  t = t.replace(/나도\s*(?:해봤는데|먹어봤는데|써봤는데|사봤는데)[^!?\n]{0,70}/gi, '');
  t = t.replace(/반찬으로\s*내놓으니까\s*다들[^!?\n]{0,70}/gi, '');
  t = t.replace(/이거\s*덕분에[^!?\n]{0,70}(?:한눈팔|마음\s*편|편해졌)[^!?\n]*/gi, '');
  return t;
}

function removeHealthExperience(text) {
  const kept = [];
  for (let line of clean(text).split('\n')) {
    line = line.trim();
    if (!line) continue;
    const m = line.search(HEALTH_EFFECT);
    if (m >= 0) {
      const before = line.slice(0, m).trim();
      if (before.length >= 8 && !/(그래서|요즘|나는|나도)$/.test(before)) kept.push(before);
      continue;
    }
    kept.push(line);
  }
  return clean(kept.join('\n'));
}

function removeWrongCta(text, recipe) {
  if (recipe) return text;
  const lines = clean(text).split('\n').filter(line => !RECIPE_CTA.test(line));
  RECIPE_CTA.lastIndex = 0;
  return clean(lines.join('\n'));
}

function splitNatural(text) {
  const source = clean(text).split('\n').map(humanizeLine).filter(Boolean);
  const out = [];
  for (let line of source) {
    while (line.length > 42) {
      const anchors = [' 근데 ', ' 그래서 ', ' 심지어 ', ' 이건 ', ' 영상 ', ' 생각보다 ', ' 원하는 ', ' 만드는 법', ' 재료랑 ', ' ㅋㅋ ', ' 쓰니까 ', ' 이사 '];
      let cut = -1;
      for (const a of anchors) {
        const p = line.lastIndexOf(a, 42);
        if (p >= 14) cut = Math.max(cut, p);
      }
      if (cut < 14) cut = line.lastIndexOf(' ', 42);
      if (cut < 14) break;
      out.push(line.slice(0, cut).trim());
      line = line.slice(cut).trim();
    }
    if (line) out.push(line);
  }
  return out.filter(x => x.length > 1).slice(0, 7).join('\n');
}

function threadify(text, result) {
  let lines = clean(text).split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.length) return '';

  // 이미 자연스러운 반응어가 있으면 억지 Threads 용어를 추가하지 않는다
  const joined = lines.join(' ');
  const hasNative = /(?:스치니|치니들|ㅋㅋ|ㅠㅠ|ㅁㅊ|ㄷㄷ|아니\s*근데|잠깐|이건\s*좀|은근)/.test(joined);
  const key = `${result?.sourceUrl || result?.source || ''}|${result?.topic || ''}|${result?.accountId || ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const bucket = Math.abs(hash) % 10;

  if (!hasNative && bucket <= 2 && lines.length) {
    // 30% 정도에서만 짧은 Threads식 호흡을 보강한다. 사실을 새로 만들지 않는다.
    if (bucket === 0) lines[0] = `아니 근데 ${lines[0]}`;
    else if (bucket === 1) lines[0] = `이건 좀 ${lines[0]}`;
    else if (bucket === 2 && !/[?]$/.test(lines[0])) lines.push('이거 아는 스치니 있어?');
  }
  return clean(lines.join('\n'));
}

function forceFixRemaining(text, opts) {
  let t = clean(text);
  for (let pass = 0; pass < 3; pass++) {
    const reasons = inspect(t, opts);
    if (!reasons.length) break;
    if (reasons.includes('wrong-recipe-cta')) t = removeWrongCta(t, opts.recipe);
    if (reasons.includes('health-effect-experience')) t = removeHealthExperience(t);
    if (reasons.includes('invented-relation') || reasons.includes('invented-experience')) t = removeInvented(t);
    if (reasons.includes('eumseum') || reasons.includes('ai-review-tone') || reasons.includes('nya')) {
      t = t.split('\n').map(humanizeLine).filter(Boolean).join('\n');
    }
    if (reasons.includes('long-line')) t = splitNatural(t);
    if (reasons.includes('reaction-overuse')) {
      let count = 0;
      t = t.replace(REACTION_TOKEN, m => (++count <= 2 ? m : ''));
    }
    t = clean(t);
  }

  // 그래도 금지 종결이 남으면 해당 표현만 최종 치환한다
  t = t
    .replace(/유용함(?=$|\s|[!?~ㅋㅎ])/gm, '쓸 만해')
    .replace(/싶어짐(?=$|\s|[!?~ㅋㅎ])/gm, '싶긴 해')
    .replace(/느껴짐(?=$|\s|[!?~ㅋㅎ])/gm, '느껴져')
    .replace(/좋음(?=$|\s|[!?~ㅋㅎ])/gm, '좋아')
    .replace(/편함(?=$|\s|[!?~ㅋㅎ])/gm, '편해')
    .replace(/있음(?=$|\s|[!?~ㅋㅎ])/gm, '있어')
    .replace(/없음(?=$|\s|[!?~ㅋㅎ])/gm, '없어');
  return splitNatural(clean(t));
}

function localGuard(text, result) {
  const recipe = isRecipeResult(result);
  const health = isHealthResult(result);
  let t = removeWrongCta(clean(text), recipe);
  t = removeInvented(t);
  if (health) t = removeHealthExperience(t);
  t = t.split('\n').map(humanizeLine).filter(Boolean).join('\n');
  let count = 0;
  t = t.replace(REACTION_TOKEN, m => (++count <= 2 ? m : ''));
  t = splitNatural(t);
  t = threadify(t, result);
  t = forceFixRemaining(t, { health, recipe });
  return clean(t);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  if (String(process.env.POST_STYLE_HUMAN_GUARD_ENABLED || '1') === '0') return result;

  result.accountId = result.accountId || accountId;
  const recipe = isRecipeResult(result);
  const health = isHealthResult(result);
  const current = clean(result.text);
  const beforeReasons = inspect(current, { health, recipe });
  const fixed = localGuard(current, result);
  const remaining = inspect(fixed, { health, recipe });

  console.log(`[AutopilotV3][POST STYLE GUARD v4] mode=${modeOf(result)||'-'} health=${health?'yes':'no'} reasons=${beforeReasons.join(',')||'none'} remaining=${remaining.join(',')||'PASS'} preview="${fixed.slice(0,200).replace(/\n/g,' / ')}"`);

  // 최종 안전장치: 여전히 중대한 금지항목이 남으면 해당 줄을 제거해 발행한다.
  let finalText = fixed;
  if (remaining.length) {
    const badLine = /(?:재료.*(?:만드는\s*법|댓글)|만드는\s*법.*댓글|유용함|싶어짐|느껴짐|좋음|편함|있음|없음)/i;
    finalText = clean(finalText.split('\n').filter(line => !badLine.test(line)).join('\n')) || fixed;
    finalText = forceFixRemaining(finalText, { health, recipe });
    const last = inspect(finalText, { health, recipe });
    console.warn(`[AutopilotV3][POST STYLE GUARD v4 FINAL] remaining=${last.join(',')||'PASS'} preview="${finalText.slice(0,200).replace(/\n/g,' / ')}"`);
  }

  return { ...result, text: finalText };
};

console.log('[AutopilotV3][POST STYLE GUARD] v4 mode-aware CTA + Threads-native + 음슴체/허구경험/건강효과 최종강제수정 · AI추가호출 없음');
module.exports = { inspect, clean, localGuard, removeHealthExperience, removeWrongCta, forceFixRemaining };
