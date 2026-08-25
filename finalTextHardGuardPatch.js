'use strict';

const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function hardSanitize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\s+\/\s+/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .replace(/\.\.+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normalizeLineBreaks(text) {
  const clean = hardSanitize(text);
  const pieces = clean.split(/(\n{2,3})/);
  const out = [];
  let total = 0;
  for (const piece of pieces) {
    if (!piece) continue;
    if (/^\n{2,3}$/.test(piece)) {
      if (out.length && !/^\n/.test(out[out.length - 1])) out.push(piece);
      continue;
    }
    const lines = piece.split('\n').map(x => x.trim()).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      if (total >= 12) break;
      kept.push(line);
      total++;
    }
    if (kept.length) out.push(kept.join('\n'));
    if (total >= 12) break;
  }
  return out.join('').replace(/\n{4,}/g, '\n\n\n').trim();
}

const INCOMPLETE_ENDINGS = [
  { re: /추천해주$/, to: '추천해줬어' }, { re: /알려주$/, to: '알려줬어' },
  { re: /보여주$/, to: '보여줬어' }, { re: /챙겨주$/, to: '챙겨줬어' },
  { re: /말해주$/, to: '말해줬어' }, { re: /먹어보$/, to: '먹어봤어' },
  { re: /써보$/, to: '써봤어' }, { re: /사용해보$/, to: '사용해봤어' },
  { re: /해보$/, to: '해봤어' }, { re: /사보$/, to: '사봤어' },
  { re: /찾아보$/, to: '찾아봤어' }, { re: /챙겨먹$/, to: '챙겨먹어' },
  { re: /생각하$/, to: '생각해' }, { re: /느껴지$/, to: '느껴져' },
  // '붙여야겠😨'처럼 종결어미가 '겠'에서 잘린 문장은 자연스러운 반말 '겠어'로 복구한다
  { re: /겠$/, to: '겠어' },
];

function hasIncompleteEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ😨😱😂🤣🥲😭]+)$/u)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length).trim() : raw;
  return INCOMPLETE_ENDINGS.some(rule => rule.re.test(core));
}
function repairIncompleteEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ😨😱😂🤣🥲😭]+)$/u)?.[1] || '';
  let core = suffix ? raw.slice(0, -suffix.length).trim() : raw;
  for (const rule of INCOMPLETE_ENDINGS) {
    if (!rule.re.test(core)) continue;
    core = core.replace(rule.re, rule.to); break;
  }
  return `${core}${suffix}`.trim();
}

function splitEndingSuffix(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ😨😱😂🤣🥲😭]+)$/u)?.[1] || '';
  return { raw, suffix, core: suffix ? raw.slice(0, -suffix.length).trim() : raw };
}

function hasEumseumEnding(line) {
  const { core } = splitEndingSuffix(line);
  return /(?:안\s*됨|됨|없음|있음|같음|보임|끝임|바뀜|사라짐|좋음|쉬움|편함|귀여움|맛있음|중임|거임|것임|상태임|느낌임|제품임|장난감임|아이템임|레시피임|방법임|문제임|핵심임|해야\s*함|필요함|가능함|추천함|사용함|구매함|생각함)$/.test(core);
}

function repairEumseumEnding(line) {
  const { suffix, core: rawCore } = splitEndingSuffix(line);
  let core = rawCore;
  const replacements = [
    [/안\s*됨$/, '안 돼'],
    [/맛있음$/, '맛있어'],
    [/귀여움$/, '귀여워'],
    [/사라짐$/, '사라져'],
    [/바뀜$/, '바뀌어'],
    [/없음$/, '없어'],
    [/있음$/, '있어'],
    [/같음$/, '같아'],
    [/보임$/, '보여'],
    [/끝임$/, '끝이야'],
    [/좋음$/, '좋아'],
    [/쉬움$/, '쉬워'],
    [/편함$/, '편해'],
    [/됨$/, '돼'],
    [/해야\s*함$/, '해야 해'],
    [/필요함$/, '필요해'],
    [/가능함$/, '가능해'],
    [/추천함$/, '추천해'],
    [/사용함$/, '사용해'],
    [/구매함$/, '구매해'],
    [/생각함$/, '생각해'],
    [/중임$/, '중이야'],
    [/거임$/, '거야'],
    [/것임$/, '거야'],
    [/상태임$/, '상태야'],
    [/느낌임$/, '느낌이야'],
    [/제품임$/, '제품이야'],
    [/장난감임$/, '장난감이야'],
    [/아이템임$/, '아이템이야'],
    [/레시피임$/, '레시피야'],
    [/방법임$/, '방법이야'],
    [/문제임$/, '문제야'],
    [/핵심임$/, '핵심이야'],
  ];
  for (const [re, to] of replacements) {
    if (!re.test(core)) continue;
    core = core.replace(re, to);
    break;
  }
  return `${core}${suffix}`.trim();
}

function isNonRecipeRecipeLine(line, mode) {
  if (mode === 'recipe') return false;
  const t = String(line || '').trim();
  return /(?:재료(?:랑|와|하고)?\s*(?:만드는\s*법|레시피)|만드는\s*법(?:은|도)?|레시피(?:는|도)?|비밀\s*(?:재료|소스)(?:는|도)?)\s*(?:댓글|답글)/i.test(t)
    || /(?:댓글|답글)(?:에|로)\s*(?:재료|만드는\s*법|레시피|비밀\s*(?:재료|소스))/i.test(t);
}

function isUnsupportedSecretIngredientLine(line, mode) {
  if (mode === 'recipe') return false;
  const t = String(line || '').trim();
  return /비밀\s*재료(?:로|라서|라|가|는|를|덕분)/i.test(t)
    || /비밀\s*소스(?:로|라서|라|가|는|를|\s*덕분)/i.test(t);
}

function badStyleReasons(text, mode) {
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const reasons = [];
  if (/(더라|하더라|했더라|더라고|하더라고|했더라고)/i.test(t)) reasons.push('더라체');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('냐체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회/i.test(t)) reasons.push('구매권유');
  if (lines.some(hasIncompleteEnding)) reasons.push('미완성어미');
  if (lines.some(hasEumseumEnding)) reasons.push('음슴체');
  if (lines.some(line => isNonRecipeRecipeLine(line, mode))) reasons.push('비레시피-레시피CTA');
  if (lines.some(line => isUnsupportedSecretIngredientLine(line, mode))) reasons.push('비레시피-비밀재료설명');
  return [...new Set(reasons)];
}

function rewriteLineEnding(line) {
  const suffix = String(line || '').match(/([!?~ㅋㅎㅠㅜ😨😱😂🤣🥲😭]+)$/u)?.[1] || '';
  let core = suffix ? String(line).slice(0, -suffix.length) : String(line);
  core = core.replace(/좋더라$/g,'좋아').replace(/편하더라$/g,'편해').replace(/있더라$/g,'있어').replace(/없더라$/g,'없어')
    .replace(/아니더라$/g,'아니야').replace(/했더라$/g,'했어').replace(/하더라$/g,'해').replace(/했더라고$/g,'했어')
    .replace(/하더라고$/g,'해').replace(/더라고$/g,'네').replace(/더라구$/g,'네').replace(/더라$/g,'네')
    .replace(/뭐냐$/g,'뭐지').replace(/거냐$/g,'건가').replace(/없냐$/g,'없나').replace(/맞냐$/g,'맞나');
  return repairEumseumEnding(repairIncompleteEnding(`${core}${suffix}`));
}

function hasUnsafeNyaEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ😨😱😂🤣🥲😭]+)$/u)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length) : raw;
  if (!/[가-힣]+냐$/.test(core)) return false;
  if (/(?:뭐냐|거냐|없냐|맞냐)$/.test(core)) return false;
  return true;
}

function fallbackRewrite(text, mode) {
  const s = hardSanitize(text)
    .split('\n')
    .filter(line => !hasUnsafeNyaEnding(line))
    .map(rewriteLineEnding)
    .filter(line => !isNonRecipeRecipeLine(line, mode))
    .filter(line => !isUnsupportedSecretIngredientLine(line, mode))
    .filter(Boolean)
    .join('\n');
  return normalizeLineBreaks(s);
}

engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  const mode = result.mode || options?.mode || '';
  const before = normalizeLineBreaks(result.text);
  const reasons = badStyleReasons(before, mode);
  result.text = reasons.length ? fallbackRewrite(before, mode) : before;
  result.text = normalizeLineBreaks(result.text);
  if (reasons.length) console.log(`[AutopilotV3][TEXT HARD GUARD] v18 fix reason=${reasons.join(',')} mode=${mode||'-'} preview="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  const remaining = badStyleReasons(result.text, mode);
  if (remaining.length) console.warn(`[AutopilotV3][TEXT HARD GUARD] 최종 잔여=${remaining.join(',')} mode=${mode||'-'} text="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  return result;
};
console.log('[Autopilot][TEXT HARD GUARD] v18 비레시피 recipe 오염 + 음슴체 종결 최소 안전정리');
module.exports = { hardSanitize, normalizeLineBreaks, badStyleReasons, fallbackRewrite, hasIncompleteEnding, repairIncompleteEnding, hasUnsafeNyaEnding, hasEumseumEnding, repairEumseumEnding, isNonRecipeRecipeLine, isUnsupportedSecretIngredientLine };
