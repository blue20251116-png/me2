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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLineBreaks(text) {
  const clean = hardSanitize(text);
  const blocks = clean.split(/\n\n+/);
  const outBlocks = [];
  let total = 0;
  for (const block of blocks) {
    const lines = block.split('\n').map(x => x.trim()).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      if (total >= 10) break;
      kept.push(line);
      total++;
    }
    if (kept.length) outBlocks.push(kept);
    if (total >= 10) break;
  }
  return outBlocks.map(lines => lines.join('\n')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

const INCOMPLETE_ENDINGS = [
  { re: /추천해주$/, to: '추천해줬어' },
  { re: /알려주$/, to: '알려줬어' },
  { re: /보여주$/, to: '보여줬어' },
  { re: /챙겨주$/, to: '챙겨줬어' },
  { re: /말해주$/, to: '말해줬어' },
  { re: /먹어보$/, to: '먹어봤어' },
  { re: /써보$/, to: '써봤어' },
  { re: /사용해보$/, to: '사용해봤어' },
  { re: /해보$/, to: '해봤어' },
  { re: /사보$/, to: '사봤어' },
  { re: /찾아보$/, to: '찾아봤어' },
  { re: /챙겨먹$/, to: '챙겨먹어' },
  { re: /생각하$/, to: '생각해' },
  { re: /느껴지$/, to: '느껴져' },
];

function hasIncompleteEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length).trim() : raw;
  return INCOMPLETE_ENDINGS.some(rule => rule.re.test(core));
}

function repairIncompleteEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  let core = suffix ? raw.slice(0, -suffix.length).trim() : raw;
  for (const rule of INCOMPLETE_ENDINGS) {
    if (!rule.re.test(core)) continue;
    core = core.replace(rule.re, rule.to);
    break;
  }
  return `${core}${suffix}`.trim();
}

function badStyleReasons(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const reasons = [];
  if (/(더라|하더라|했더라|더라고|하더라고|했더라고)/i.test(t)) reasons.push('더라체');
  // 음슴체는 실제 Threads 문체로 허용한다. 여기서 교정/차단하지 않는다.
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('냐체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/강력\s*추천|무조건\s*추천|꼭\s*써봐|놓치면\s*후회/i.test(t)) reasons.push('구매권유');
  if (lines.some(hasIncompleteEnding)) reasons.push('미완성어미');
  return [...new Set(reasons)];
}

function rewriteLineEnding(line) {
  const suffix = String(line || '').match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  let core = suffix ? String(line).slice(0, -suffix.length) : String(line);
  core = core
    .replace(/좋더라$/g, '좋아')
    .replace(/편하더라$/g, '편해')
    .replace(/있더라$/g, '있어')
    .replace(/없더라$/g, '없어')
    .replace(/아니더라$/g, '아니야')
    .replace(/했더라$/g, '했어')
    .replace(/하더라$/g, '해')
    .replace(/했더라고$/g, '했어')
    .replace(/하더라고$/g, '해')
    .replace(/더라고$/g, '네')
    .replace(/더라구$/g, '네')
    .replace(/더라$/g, '네')
    .replace(/뭐냐$/g, '뭐지')
    .replace(/거냐$/g, '건가')
    .replace(/없냐$/g, '없나')
    .replace(/맞냐$/g, '맞나');
  return repairIncompleteEnding(`${core}${suffix}`);
}

function hasUnsafeNyaEnding(line) {
  const raw = String(line || '').trim();
  const suffix = raw.match(/([!?~ㅋㅎㅠㅜ]+)$/)?.[1] || '';
  const core = suffix ? raw.slice(0, -suffix.length) : raw;
  if (!/[가-힣]+냐$/.test(core)) return false;
  if (/(?:뭐냐|거냐|없냐|맞냐)$/.test(core)) return false;
  return true;
}

function fallbackRewrite(text) {
  const s = hardSanitize(text)
    .split('\n')
    .filter(line => !hasUnsafeNyaEnding(line))
    .map(rewriteLineEnding)
    .join('\n');
  return normalizeLineBreaks(s);
}

engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  const before = normalizeLineBreaks(result.text);
  const reasons = badStyleReasons(before);
  result.text = reasons.length ? fallbackRewrite(before) : before;
  result.text = normalizeLineBreaks(result.text);
  if (reasons.length) console.log(`[AutopilotV3][TEXT HARD GUARD] v15 fix reason=${reasons.join(',')} preview="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  const remaining = badStyleReasons(result.text);
  if (remaining.length) console.warn(`[AutopilotV3][TEXT HARD GUARD] 최종 잔여=${remaining.join(',')} text="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  return result;
};

console.log('[Autopilot][TEXT HARD GUARD] v15 음슴체 허용 · 최소 문체 안전정리');
module.exports = { hardSanitize, normalizeLineBreaks, badStyleReasons, fallbackRewrite, hasIncompleteEnding, repairIncompleteEnding, hasUnsafeNyaEnding };
