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

function splitLongLine(line, maxLen = 42) {
  let rest = String(line || '').trim();
  if (!rest || rest.length <= maxLen) return [rest].filter(Boolean);
  const chunks = [];
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < 18) break;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function normalizeLineBreaks(text) {
  const clean = hardSanitize(text);
  const blocks = clean.split(/\n\n+/);
  const outBlocks = [];
  let total = 0;
  for (const block of blocks) {
    const rawLines = block.split('\n').map(x => x.trim()).filter(Boolean);
    const lines = [];
    for (const raw of rawLines) {
      for (const part of splitLongLine(raw)) {
        if (total >= 8) break;
        if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ|ㅠ{1,5}|ㅜ{1,5})[!?]*$/.test(part)) {
          if (lines.length) lines[lines.length - 1] += part;
          else if (outBlocks.length) outBlocks[outBlocks.length - 1][outBlocks[outBlocks.length - 1].length - 1] += part;
          continue;
        }
        lines.push(part);
        total++;
      }
      if (total >= 8) break;
    }
    if (lines.length) outBlocks.push(lines);
    if (total >= 8) break;
  }
  return outBlocks.map(lines => lines.join('\n')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function badStyleReasons(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const reasons = [];
  if (/(더라|하더라|했더라|더라고|하더라고|했더라고)/i.test(t)) reasons.push('더라체');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|끝남)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('음슴체');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('냐체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/추천|장만|필수템|꿀템/i.test(t)) reasons.push('구매권유');
  if (lines.some(line => line.length > 52)) reasons.push('긴줄');
  if (/(실물\s*(?:보니까|봤는데)|직접\s*(?:보니까|써보니까|사용해보니까)|써보니까|사용해보니까|사봤는데|구매했는데|재구매|추가\s*구매)/i.test(t)) reasons.push('확인안된경험');
  return [...new Set(reasons)];
}

function fallbackRewrite(text) {
  let s = hardSanitize(text)
    .replace(/불편함/g, '불편해')
    .replace(/해결됨/g, '해결돼')
    .replace(/편함/g, '편해')
    .replace(/좋음/g, '좋아')
    .replace(/있음/g, '있어')
    .replace(/없음/g, '없어')
    .replace(/끝남/g, '끝나')
    .replace(/좋더라/g, '좋아')
    .replace(/편하더라/g, '편해')
    .replace(/했더라/g, '했어')
    .replace(/하더라/g, '해')
    .replace(/했더라고/g, '했어')
    .replace(/하더라고/g, '해')
    .replace(/더라고/g, '')
    .replace(/더라/g, '')
    .replace(/뭐냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '뭐지')
    .replace(/거냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '건가')
    .replace(/없냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '없나')
    .replace(/맞냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '맞나')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나');
  return normalizeLineBreaks(s);
}

engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  const before = normalizeLineBreaks(result.text);
  const reasons = badStyleReasons(before);
  result.text = reasons.length ? fallbackRewrite(before) : before;
  result.text = normalizeLineBreaks(result.text);
  if (reasons.length) console.log(`[AutopilotV3][TEXT HARD GUARD] v11 fix reason=${reasons.join(',')} preview="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  const remaining = badStyleReasons(result.text);
  if (remaining.length) console.warn(`[AutopilotV3][TEXT HARD GUARD] 최종 잔여=${remaining.join(',')} text="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  return result;
};

console.log('[Autopilot][TEXT HARD GUARD] v11 빈줄 보존 + 로컬 최종검사');
module.exports = { hardSanitize, normalizeLineBreaks, badStyleReasons, fallbackRewrite };
