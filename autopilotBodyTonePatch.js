'use strict';

const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function cleanBody(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function needsNaturalRewrite(text) {
  const body = cleanBody(text);
  if (!body) return false;
  const lines = body.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length <= 2) return true;
  if (lines.some((x) => x.length > 42)) return true;
  if (/왜\s*감\s+\S/.test(body)) return true;
  if (lines.some((x) => /^(진짜|그냥|근데|그래서|그리고|이거)$/.test(x))) return true;
  return false;
}

function localBodyCleanup(text) {
  let body = cleanBody(text);
  if (!body) return body;

  body = body
    .replace(/\b간편하게\b/g, '쉽게')
    .replace(/\b실용적(?:이야|이다|인)?\b/g, '')
    .replace(/\b효율적(?:이야|이다|인)?\b/g, '')
    .replace(/\b활용도(?:가)?\b/g, '')
    .replace(/\s{2,}/g, ' ');

  const lines = body.split('\n').map((x) => x.trim()).filter(Boolean);
  const merged = [];
  const dangling = /(은|는|이|가|을|를|도|만|에|의|와|과|로|으로|부터|까지|해서|하고|는데|니까|면|지만|다가|거나|처럼|보다|정도)$/;
  const weak = /^(진짜|그냥|근데|그래서|그리고|이거)$/;

  for (const line of lines) {
    if (!merged.length) {
      merged.push(line);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (weak.test(line) || dangling.test(prev)) merged[merged.length - 1] = `${prev} ${line}`.trim();
    else merged.push(line);
  }

  return merged.slice(0, 6).join('\n').trim();
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  const current = localBodyCleanup(result.text);
  if (needsNaturalRewrite(current)) {
    console.log(`[AutopilotV3][BODY TONE] local-only cleanup preview="${current.slice(0, 160).replace(/\n/g, ' / ')}"`);
  }
  return { ...result, text: current };
};

console.log('[AutopilotV3][BODY TONE] AI 호출 제거 · 로컬 정리 전용');

module.exports = { needsNaturalRewrite, cleanBody, localBodyCleanup };
