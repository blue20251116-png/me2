'use strict';

const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

const EMPTY_AI_PHRASES = /(?:없는\s*삶은?\s*상상도\s*못|없이는?\s*못\s*살|중독될\s*수밖에|그냥\s*.+(?:이|가)\s*아닌\s*듯|이렇게\s*매력적이었나|완전\s*기대(?:됨|돼)|대체\s*어떤\s*건지\s*궁금|다\s*알겠지|정답이지|행복해\s*보이다니)/i;
const INVENTED_RELATION = /(?:친구|남편|아내|언니|오빠|동생|엄마|아빠|지인|주변\s*사람).{0,40}(?:행복해|좋아해|먹고|쓰고|샀|추천|말했|난리|부풀|반응)/i;
const REACTION_TOKEN = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|ㅠㅠ+|ㅜㅜ+|😆|😂|🤣|🔥|헐|존맛탱|개맛|미쳤)/gi;

function inspect(text) {
  const t = clean(text);
  const reasons = [];
  if (EMPTY_AI_PHRASES.test(t)) reasons.push('empty-ai-sentiment');
  if (INVENTED_RELATION.test(t)) reasons.push('invented-relation');
  const reactions = t.match(REACTION_TOKEN) || [];
  if (reactions.length > 2) reasons.push('reaction-overuse');
  if (/ㅎㅎ/.test(t) && /ㅁㅊ/.test(t)) reasons.push('mixed-forced-reaction');
  if (/ㅋㅋ/.test(t) && /ㅎㅎ/.test(t) && /[😆😂🤣]/.test(t)) reasons.push('mixed-forced-reaction');
  if (/(\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량|뺐)|\d+\s*(?:주|일|개월)째\s*(?:먹|쓰|사용)|한\s*달\s*만에\s*효과)/i.test(t)) reasons.push('unsafe-experience-claim');
  return [...new Set(reasons)];
}

function localGuard(text) {
  let t = clean(text);
  t = t
    .replace(/없는\s*삶은?\s*상상도\s*못[^\n]*/gi, '')
    .replace(/없이는?\s*못\s*살[^\n]*/gi, '')
    .replace(/중독될\s*수밖에[^\n]*/gi, '')
    .replace(/나도\s*\d+(?:\.\d+)?\s*(?:주|일|개월)째[^\n]*/gi, '')
    .replace(/\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량했|뺐)[^\n]*/gi, '')
    .replace(/한\s*달\s*만에\s*효과[^\n]*/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  let reactionCount = 0;
  t = t.replace(REACTION_TOKEN, (m) => {
    reactionCount += 1;
    return reactionCount <= 2 ? m : '';
  });
  return clean(t);
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

console.log('[AutopilotV3][POST STYLE GUARD] AI 호출 제거 · 로컬 안전검사 전용');

module.exports = { inspect, clean, localGuard };
