'use strict';
const { normalizeVoice, voiceGuide, voiceProblems } = require('./threadsVoicePolicy');

const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function cleanBody(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function needsNaturalRewrite(text) {
  const body = cleanBody(text);
  if (!body) return false;
  const lines = body.split('\n').map(x=>x.trim()).filter(Boolean);
  if (lines.length <= 2) return true;
  if (lines.some(x=>x.length > 42)) return true;
  if (/왜\s*감\s+\S/.test(body)) return true;
  return false;
}

function localBodyCleanup(text) {
  let body = cleanBody(text);
  if (!body) return body;
  body = body.replace(/\b간편하게\b/g,'쉽게')
    .replace(/\b실용적(?:이야|이다|인)?\b/g,'')
    .replace(/\b효율적(?:이야|이다|인)?\b/g,'')
    .replace(/\b활용도(?:가)?\b/g,'')
    .replace(/[ \t]{2,}/g,' ');

  // 생성기가 의도한 사건형 행과 문단을 다시 합치지 않는다.
  // 특히 '근데/진짜/그래서/이거' 및 단독 반응행은 Threads 호흡으로 보존한다.
  const pieces = body.split(/(\n{2,3})/);
  const out = [];
  let total = 0;
  for (const piece of pieces) {
    if (!piece) continue;
    if (/^\n{2,3}$/.test(piece)) {
      if (out.length && !/^\n/.test(out[out.length - 1])) out.push(piece);
      continue;
    }
    const kept = [];
    for (const line of piece.split('\n').map(x=>x.trim()).filter(Boolean)) {
      kept.push(line);
      total++;
    }
    if (kept.length) out.push(kept.join('\n'));
  }
  return out.join('').replace(/\n{4,}/g,'\n\n\n').trim();
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const current = localBodyCleanup(result.text);
  if (needsNaturalRewrite(current)) console.log(`[AutopilotV3][BODY TONE] v12 preserve-only preview="${current.slice(0,160).replace(/\n/g,' / ')}"`);
  return { ...result, text: current };
};
console.log('[AutopilotV3][BODY TONE] v12 사건형 행 합치지 않음 · 빈줄2개/최대12행 보존');
module.exports = { needsNaturalRewrite, cleanBody, localBodyCleanup };

