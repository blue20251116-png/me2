'use strict';

const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function hardSanitize(text) {
  let s = String(text || '').replace(/\r/g, '');
  // 이전 패치/모델이 줄바꿈 대신 넣은 구분자를 실제 개행으로 복원
  s = s.replace(/\s+\/\s+/g, '\n');
  s = s.replace(/\\n/g, '\n');
  s = s.replace(/,/g, '');
  s = s.replace(/(^|[^0-9])\.(?![0-9])/g, '$1');
  s = s.replace(/\.\.+/g, '');

  const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ|ㅠ{1,5}|ㅜ{1,5})[!?]*$/.test(line)) {
      if (out.length) out[out.length - 1] += line;
      continue;
    }
    out.push(line);
  }

  return out.slice(0, 8).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitLongLine(line, maxLen = 38) {
  let rest = String(line || '').trim();
  if (!rest || rest.length <= maxLen) return [rest].filter(Boolean);

  const chunks = [];
  // 문장부호를 최종적으로 지우더라도 먼저 자연스러운 문장 경계를 보존
  const sentenceParts = rest
    .split(/(?<=[!?~])\s+|\s+(?=(?:근데|그래서|심지어|이건|이거|처음엔|재료랑|만드는 법|레시피|댓글))/)
    .map(x => x.trim())
    .filter(Boolean);

  for (let part of sentenceParts) {
    while (part.length > maxLen) {
      const window = part.slice(0, maxLen + 8);
      let cut = -1;
      // 조사/연결어 직후가 아니라 의미 덩어리 뒤 공백을 우선 사용
      const preferred = [...window.matchAll(/\s+(?=(?:근데|그래서|심지어|이건|이거|처음엔|재료랑|만드는|집에서|반찬|소스|두\s*층|완전|진짜))/g)];
      if (preferred.length) cut = preferred[preferred.length - 1].index;
      if (cut < 18) cut = window.lastIndexOf(' ', maxLen);
      if (cut < 18) cut = window.indexOf(' ', Math.min(28, window.length - 1));
      if (cut < 1) break;
      chunks.push(part.slice(0, cut).trim());
      part = part.slice(cut).trim();
    }
    if (part) chunks.push(part);
  }
  return chunks.filter(Boolean);
}

function normalizeLineBreaks(text) {
  const clean = hardSanitize(text);
  const rawLines = clean.split('\n').map(x => x.trim()).filter(Boolean);
  const lines = [];
  for (const raw of rawLines) lines.push(...splitLongLine(raw));

  // 너무 잘게 쪼개진 한두 단어 줄은 앞줄에 붙인다
  const merged = [];
  for (const line of lines) {
    if (line.length <= 5 && merged.length) merged[merged.length - 1] += ` ${line}`;
    else merged.push(line);
  }

  return merged.slice(0, 8).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasAwkwardLineBreak(text) {
  const lines = String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const danglingEnd = /(은|는|이|가|을|를|도|만|에|의|와|과|로|으로|부터|까지|해서|하고|는데|니까|면|지만|다가|거나|처럼|보다|정도)$/;
  const awkwardStart = /^(보이|달라지|되어|돼|해서|하고|그러니까|때문에|같아서|같으니까)/;
  for (let i = 0; i < lines.length - 1; i++) {
    if (danglingEnd.test(lines[i]) || awkwardStart.test(lines[i + 1])) return true;
  }
  return false;
}

function badStyleReasons(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const reasons = [];
  if (/(더라|하더라|했더라|더라고|하더라고|했더라고)/i.test(t)) reasons.push('더라체');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|남다름|끝남|해결됨)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('음슴체');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('냐체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/필수인듯|좋은듯|괜찮은듯|되는듯|같은듯/i.test(t)) reasons.push('듯체');
  if (/추천|장만|괜찮을 거야|필수템|꿀템/i.test(t)) reasons.push('구매권유');
  if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ)[!?]*$/m.test(t)) reasons.push('단독반응');
  if (hasAwkwardLineBreak(t)) reasons.push('어색한줄바꿈');
  if (lines.some(line => line.length > 46)) reasons.push('긴줄');
  if (/(실물\s*(?:보니까|봤는데)|직접\s*(?:보니까|써보니까|사용해보니까)|써보니까|사용해보니까|사봤는데|구매했는데|재구매|추가\s*구매|요즘\s*쓰는\s*중)/i.test(t)) reasons.push('확인안된경험');
  if (/(\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량|뺐)|\d+\s*(?:주|일|개월)째\s*(?:먹|쓰|사용)|한\s*달\s*만에\s*효과)/i.test(t)) reasons.push('위험경험수치');
  return [...new Set(reasons)];
}

function fallbackRewrite(text) {
  let s = hardSanitize(text);
  const pairs = [
    [/불편함/g, '불편해'], [/해결됨/g, '해결돼'], [/편함/g, '편해'], [/좋음/g, '좋아'],
    [/남다름/g, '확실히 달라'], [/있음/g, '있어'], [/없음/g, '없어'], [/끝남/g, '끝나'],
    [/필수인듯/g, '필요할 것 같아'], [/좋은듯/g, '좋은 것 같아'], [/괜찮은듯/g, '괜찮은 것 같아']
  ];
  for (const [re, to] of pairs) s = s.replace(re, to);

  s = s
    .replace(/달라지더라/g, '확실히 달라')
    .replace(/좋더라/g, '좋아')
    .replace(/편하더라/g, '편해')
    .replace(/놀랐더라/g, '놀랐어')
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
    .replace(/했냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '했나')
    .replace(/봤냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '봤나')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나')
    .replace(/나도\s*\d+(?:\.\d+)?\s*(?:주|일|개월)째[^\n]*/gi, '')
    .replace(/\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량했|뺐)[^\n]*/gi, '')
    .replace(/한\s*달\s*만에\s*효과[^\n]*/gi, '');

  return normalizeLineBreaks(s);
}

engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  const before = normalizeLineBreaks(result.text);
  const reasons = badStyleReasons(before);
  result.text = reasons.length ? fallbackRewrite(before) : before;
  // 문제가 없더라도 마지막에 실제 개행을 보장
  result.text = normalizeLineBreaks(result.text);

  if (reasons.length) {
    console.log(`[AutopilotV3][TEXT HARD GUARD] local-only fix reason=${reasons.join(',')} preview="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  }

  const remaining = badStyleReasons(result.text);
  if (remaining.length) {
    console.warn(`[AutopilotV3][TEXT HARD GUARD] 최종 잔여=${remaining.join(',')} text="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  }
  return result;
};

console.log('[Autopilot][TEXT HARD GUARD] AI 호출 제거 · 로컬 최종검사 + 실제 줄바꿈 보정 활성화');

module.exports = { hardSanitize, normalizeLineBreaks, badStyleReasons, fallbackRewrite };
