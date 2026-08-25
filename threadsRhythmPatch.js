'use strict';

// Threads body rhythm patch
// 목적: 현재 생성된 문장/말투는 그대로 두고 줄바꿈과 빈 줄만 자연스럽게 정리한다.
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

function preserveOnlyRhythm(text) {
  const src = clean(text);
  if (!src) return src;

  // 이미 생성기가 문단을 만든 경우 그 구조를 우선 보존한다.
  if (/\n\s*\n/.test(src)) return src;

  const lines = src.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 3) return src;

  // 문장 내용은 바꾸지 않고 4줄 이상일 때만 중간에 한 번 호흡을 준다.
  // 3줄은 그대로 두어 모든 글이 같은 레이아웃이 되는 것을 막는다.
  if (lines.length === 3) return lines.join('\n');

  const cut = lines.length === 4 ? 2 : Math.min(3, Math.max(2, Math.floor(lines.length / 2)));
  return `${lines.slice(0, cut).join('\n')}\n\n${lines.slice(cut).join('\n')}`
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
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

  console.log(`[AutopilotV3][THREADS RHYTHM] preserve-only lines=${after.split('\n').filter(Boolean).length} preview="${after.slice(0,160).replace(/\n/g,' / ')}"`);
  return { ...result, text: after };
};

console.log('[AutopilotV3][THREADS RHYTHM] v1 문장 100% 보존 · 줄바꿈/빈줄 전용');

module.exports = { clean, normalizeForCompare, preserveOnlyRhythm, contentPreserved };
