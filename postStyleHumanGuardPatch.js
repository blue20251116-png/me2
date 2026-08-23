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

function inspect(text) {
  const t = clean(text);
  const reasons = [];
  if (/(?:활용도(?:도)?\s*높|진짜\s*편리|완전\s*좋|스트레스가\s*확\s*줄|완전\s*다른\s*세상|진입장벽이\s*낮|나만의\s*스타일|재밌을\s*것\s*같|해보고\s*싶어|왜\s*이렇게\s*쉽게\s*느껴)/i.test(t)) reasons.push('ai-review-tone');
  if (new RegExp(`(?:우리\\s*)?${REL}.{0,55}(?:행복|좋아|먹|쓰|샀|추천|말했|물어|난리|반응|손이\\s*가|비웠)`, 'i').test(t)) reasons.push('invented-relation');
  if (/(?:나도\s*(?:해봤|먹어봤|써봤|사봤)|집들이\s*때|반찬으로\s*내놓으니까|어디서\s*샀냐고|밥\s*두\s*(?:공기|그릇))/i.test(t)) reasons.push('invented-experience');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|끝남|싶어짐|느껴짐|생각남|보임)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('eumseum');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya');
  if (t.split('\n').some(x => x.length > 46)) reasons.push('long-line');
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
    .replace(/완전\s*다른\s*세상/g, '생각했던 거랑 좀 다르네')
    .replace(/진짜\s*편리해/g, '이건 좀 편하겠다')
    .replace(/활용도(?:도)?\s*높[^!?\n]*/g, '')
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
  return t;
}

function splitNatural(text) {
  const source = clean(text).split('\n').map(humanizeLine).filter(Boolean);
  const out = [];
  for (let line of source) {
    if (line.length <= 42) { out.push(line); continue; }
    const anchors = [' 근데 ', ' 그래서 ', ' 심지어 ', ' 이건 ', ' 영상 ', ' 생각보다 ', ' 원하는 ', ' 만드는 법', ' 재료랑 ', ' ㅋㅋ '];
    while (line.length > 42) {
      let cut = -1;
      for (const a of anchors) {
        const p = line.lastIndexOf(a, 42);
        if (p >= 16) cut = Math.max(cut, p);
      }
      if (cut < 16) cut = line.lastIndexOf(' ', 42);
      if (cut < 16) break;
      out.push(line.slice(0, cut).trim());
      line = line.slice(cut).trim();
    }
    if (line) out.push(line);
  }
  return out.filter(x => x.length > 1).slice(0, 7).join('\n');
}

function localGuard(text) {
  let t = removeInvented(clean(text));
  t = t.split('\n').map(humanizeLine).filter(Boolean).join('\n');
  let count = 0;
  t = t.replace(REACTION_TOKEN, m => (++count <= 2 ? m : ''));
  t = splitNatural(t);
  return clean(t);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  if (String(process.env.POST_STYLE_HUMAN_GUARD_ENABLED || '1') === '0') return result;

  const current = clean(result.text);
  const reasons = inspect(current);
  // 최종 단계에서는 PASS여도 항상 humanize를 한 번 적용한다
  const fixed = localGuard(current);
  const remaining = inspect(fixed);
  console.log(`[AutopilotV3][POST STYLE GUARD v2] ${reasons.length ? 'LOCAL-FIX' : 'HUMANIZE'} reasons=${reasons.join(',') || 'none'} remaining=${remaining.join(',') || 'PASS'} preview="${fixed.slice(0,180).replace(/\n/g,' / ')}"`);
  return { ...result, text: fixed };
};

console.log('[AutopilotV3][POST STYLE GUARD] v2 최종 인간말투 · 음슴체/가짜경험/광고감상문 제거 · AI추가호출 없음');
module.exports = { inspect, clean, localGuard };
