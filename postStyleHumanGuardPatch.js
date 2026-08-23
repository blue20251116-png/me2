'use strict';

const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\s+\/\s+/g, '\n')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

const EMPTY_AI_PHRASES = /(?:없는\s*삶은?\s*상상도\s*못|없이는?\s*못\s*살|중독될\s*수밖에|이렇게\s*매력적이었나|완전\s*기대(?:됨|돼)|대체\s*어떤\s*건지\s*궁금|다\s*알겠지|정답이지|활용도(?:도)?\s*높|진짜\s*편리|완전\s*좋|스트레스가\s*확\s*줄|완전\s*다른\s*세상)/i;
const INVENTED_RELATION = /(?:우리\s*)?(?:친구|남편|아내|시어머니|언니|오빠|동생|엄마|아빠|딸|아들|지인|주변\s*사람).{0,45}(?:행복해|좋아해|먹고|먹어|쓰고|샀|추천|말했|물어|난리|반응|손이\s*가|비웠)/i;
const INVENTED_EXPERIENCE = /(?:나도\s*(?:해봤|먹어봤|써봤|사봤)|집들이\s*때|반찬으로\s*내놓으니까\s*다들|어디서\s*샀냐고\s*물어|밥\s*두\s*공기|밥\s*두\s*그릇)/i;
const REACTION_TOKEN = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|ㅠㅠ+|ㅜㅜ+|😆|😂|🤣|🔥|헐|존맛탱|개맛|미쳤)/gi;

function inspect(text) {
  const t = clean(text);
  const reasons = [];
  if (EMPTY_AI_PHRASES.test(t)) reasons.push('empty-ai-sentiment');
  if (INVENTED_RELATION.test(t)) reasons.push('invented-relation');
  if (INVENTED_EXPERIENCE.test(t)) reasons.push('invented-experience');
  const reactions = t.match(REACTION_TOKEN) || [];
  if (reactions.length > 2) reasons.push('reaction-overuse');
  if (/ㅎㅎ/.test(t) && /ㅁㅊ/.test(t)) reasons.push('mixed-forced-reaction');
  if (/ㅋㅋ/.test(t) && /ㅎㅎ/.test(t) && /[😆😂🤣]/.test(t)) reasons.push('mixed-forced-reaction');
  if (/(\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량|뺐)|\d+\s*(?:주|일|개월)째\s*(?:먹|쓰|사용)|한\s*달\s*만에\s*효과)/i.test(t)) reasons.push('unsafe-experience-claim');
  return [...new Set(reasons)];
}

function removeCannedExperience(line) {
  let s = String(line || '').trim();
  const patterns = [
    /(?:우리\s*)?(?:남편|아내|시어머니|딸|아들|친구|엄마|아빠)[^!?\n]{0,55}(?:밥\s*두\s*(?:공기|그릇)[^!?\n]*|계속\s*손이\s*가[^!?\n]*|어디서\s*샀냐고[^!?\n]*|반응이\s*미쳤[^!?\n]*|난리[^!?\n]*)/gi,
    /집들이\s*때[^!?\n]{0,60}/gi,
    /나도\s*(?:해봤는데|먹어봤는데|써봤는데|사봤는데)[^!?\n]{0,60}/gi,
    /반찬으로\s*내놓으니까\s*다들[^!?\n]{0,60}/gi,
  ];
  for (const re of patterns) s = s.replace(re, '').trim();
  return s.replace(/\s{2,}/g, ' ').trim();
}

function localGuard(text) {
  let t = clean(text);
  t = t
    .replace(/없는\s*삶은?\s*상상도\s*못[^\n]*/gi, '')
    .replace(/없이는?\s*못\s*살[^\n]*/gi, '')
    .replace(/중독될\s*수밖에[^\n]*/gi, '')
    .replace(/활용도(?:도)?\s*높[^\n]*/gi, '')
    .replace(/스트레스가\s*확\s*줄[^\n]*/gi, '')
    .replace(/완전\s*다른\s*세상/gi, '생각보다 괜찮아')
    .replace(/진짜\s*편리해/gi, '이건 좀 편하겠다')
    .replace(/완전\s*좋아!?/gi, '')
    .replace(/나도\s*\d+(?:\.\d+)?\s*(?:주|일|개월)째[^\n]*/gi, '')
    .replace(/\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량했|뺐)[^\n]*/gi, '')
    .replace(/한\s*달\s*만에\s*효과[^\n]*/gi, '');

  t = t.split('\n').map(removeCannedExperience).filter(Boolean).join('\n');

  let reactionCount = 0;
  t = t.replace(REACTION_TOKEN, (m) => {
    reactionCount += 1;
    return reactionCount <= 2 ? m : '';
  });
  return clean(t).replace(/\n{3,}/g, '\n\n');
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  if (String(process.env.POST_STYLE_HUMAN_GUARD_ENABLED || '1') === '0') return result;

  const current = clean(result.text);
  const reasons = inspect(current);
  const fixed = reasons.length ? localGuard(current) : current;
  const remaining = inspect(fixed);

  if (!reasons.length) {
    console.log(`[AutopilotV3][POST STYLE GUARD] PASS preview="${current.slice(0, 160).replace(/\n/g, ' / ')}"`);
  } else {
    console.log(`[AutopilotV3][POST STYLE GUARD] LOCAL-FIX reasons=${reasons.join(',')} remaining=${remaining.join(',') || 'PASS'} preview="${fixed.slice(0,160).replace(/\n/g,' / ')}"`);
  }
  return { ...result, text: fixed };
};

console.log('[AutopilotV3][POST STYLE GUARD] AI 호출 제거 · 가짜관계/광고상투어 로컬 제거 활성화');

module.exports = { inspect, clean, localGuard };
