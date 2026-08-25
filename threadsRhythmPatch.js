'use strict';

// Threads body rhythm patch
// 목적: 문장/말투는 그대로 두고 의미 단위 줄바꿈과 빈 줄만 자연스럽게 정리한다.
// 새 표현, ㅋㅋ, 감탄사, CTA를 추가하지 않는다.

const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normalizeForCompare(text) {
  return clean(text).replace(/\s+/g, '');
}

function looksLikeNaturalEnding(word) {
  return /(?:했다|했어|였어|있어|없어|좋아|같아|더라|더라고|거야|잖아|인데|했는데|해|돼|줘|봐|네|지|까|자|다|듯해|듯|임|함)[!?~ㅋㅎㅠㅜ]*$/.test(String(word || ''));
}

function splitSemanticLine(line) {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.length ? [words[0]] : [];

  const units = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    const joined = current.join(' ');
    // 글자수로 강제로 자르지 않는다. 충분한 길이 + 자연스러운 어미가 있을 때만 끊는다.
    if (joined.length >= 20 && looksLikeNaturalEnding(word)) {
      units.push(joined);
      current = [];
    }
  }
  if (current.length) units.push(current.join(' '));
  return units;
}

function preserveOnlyRhythm(text) {
  const src = clean(text);
  if (!src) return src;

  // 기존 빈 줄을 무조건 신뢰하지 않는다. 긴 덩어리는 의미 단위로 다시 호흡을 만든다.
  const rawParagraphs = src.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const units = [];
  for (const paragraph of rawParagraphs) {
    const physicalLines = paragraph.split('\n').map(x => x.trim()).filter(Boolean);
    for (const line of physicalLines) {
      units.push(...splitSemanticLine(line));
    }
  }

  if (units.length <= 1) return src;

  // 1~2개 의미 단위마다 한 문단. 문장 중간 hard-wrap은 하지 않는다.
  const paragraphs = [];
  for (let i = 0; i < units.length; ) {
    const remain = units.length - i;
    const take = remain === 3 ? 1 : Math.min(2, remain);
    paragraphs.push(units.slice(i, i + take).join('\n'));
    i += take;
  }

  return paragraphs.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function contentPreserved(before, after) {
  return normalizeForCompare(before) === normalizeForCompare(after);
}

engine.buildThreadsFirstAutopilot = async function threadsRhythmBuild(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  const before = clean(result.text);
  const after = preserveOnlyRhythm(before);

  if (!contentPreserved(before, after)) {
    console.warn('[AutopilotV3][THREADS RHYTHM] content-preserve guard failed → 원문 유지');
    return { ...result, text: before };
  }

  console.log(`[AutopilotV3][THREADS RHYTHM] v2 semantic-paragraphs=${after.split(/\n{2,}/).filter(Boolean).length} preview="${after.slice(0,160).replace(/\n/g,' / ')}"`);
  return { ...result, text: after };
};

console.log('[AutopilotV3][THREADS RHYTHM] v2 의미단위 개행 · 문장중간 강제개행 금지 · 내용 100% 보존');

module.exports = { clean, normalizeForCompare, splitSemanticLine, preserveOnlyRhythm, contentPreserved };
