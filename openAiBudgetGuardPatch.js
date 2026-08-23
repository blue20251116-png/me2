'use strict';

const axios = require('axios');
const crypto = require('crypto');

const originalPost = axios.post.bind(axios);
let queue = Promise.resolve();
let lastStartAt = 0;
const MIN_GAP_MS = Math.max(800, Number(process.env.OPENAI_MIN_GAP_MS || 1600));
const ANALYSIS_CACHE_MS = Math.max(5 * 60 * 1000, Number(process.env.OPENAI_ANALYSIS_CACHE_MS || 24 * 60 * 60 * 1000));
const analysisCache = new Map();
const MAX_CACHE = 500;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isOpenAI(url) { return String(url || '') === 'https://api.openai.com/v1/chat/completions'; }
function errorMessage(e) { return String(e?.response?.data?.error?.message || e?.message || ''); }
function isTpm429(e) { return Number(e?.response?.status || 0) === 429 && /tokens per min|TPM|rate limit reached/i.test(errorMessage(e)); }
function isNoCredits(e) { return Number(e?.response?.status || 0) === 429 && /no credits remaining|add credits/i.test(errorMessage(e)); }
function isCacheableAnalysis(data) {
  const t = Number(data?.temperature);
  return Number.isFinite(t) && t <= 0.15 && Array.isArray(data?.messages);
}
function cacheKey(data) {
  const stable = JSON.stringify({
    model: data?.model,
    temperature: data?.temperature,
    max_tokens: data?.max_tokens,
    response_format: data?.response_format,
    messages: data?.messages,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}
function pruneCache() {
  const now = Date.now();
  for (const [k, v] of analysisCache) if (now - v.at > ANALYSIS_CACHE_MS) analysisCache.delete(k);
  while (analysisCache.size > MAX_CACHE) analysisCache.delete(analysisCache.keys().next().value);
}

async function runOpenAI(url, data, config) {
  let key = null;
  if (isCacheableAnalysis(data)) {
    key = cacheKey(data);
    const hit = analysisCache.get(key);
    if (hit && Date.now() - hit.at <= ANALYSIS_CACHE_MS) {
      console.log('[OpenAI][ANALYSIS CACHE HIT] low-temp request reused');
      return hit.response;
    }
  }

  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastStartAt));
  if (wait) await sleep(wait);
  lastStartAt = Date.now();

  let response;
  try {
    response = await originalPost(url, data, config);
  } catch (e) {
    if (isNoCredits(e)) {
      e.__openAiNoRetry = true;
      throw e;
    }
    if (!isTpm429(e)) throw e;

    const msg = errorMessage(e);
    const m = msg.match(/try again in\s+([0-9.]+)\s*(ms|s)/i);
    let retryMs = 1800;
    if (m) retryMs = m[2].toLowerCase() === 's' ? Math.ceil(Number(m[1]) * 1000) : Math.ceil(Number(m[1]));
    retryMs = Math.max(1200, Math.min(5000, retryMs + 500));
    console.warn(`[OpenAI][TPM GUARD] 429 → ${retryMs}ms 대기 후 1회 재시도`);
    await sleep(retryMs);
    lastStartAt = Date.now();
    response = await originalPost(url, data, config);
  }

  if (key && response) {
    analysisCache.set(key, { at: Date.now(), response });
    pruneCache();
    console.log(`[OpenAI][ANALYSIS CACHE SAVE] ttl=${Math.round(ANALYSIS_CACHE_MS / 3600000)}h size=${analysisCache.size}`);
  }
  return response;
}

axios.post = function budgetGuardedPost(url, data, config) {
  if (!isOpenAI(url)) return originalPost(url, data, config);
  const task = queue.then(() => runOpenAI(url, data, config));
  queue = task.catch(() => {});
  return task;
};

console.log(`[OpenAI][BUDGET GUARD] concurrency=1 minGap=${MIN_GAP_MS}ms TPM429 retry=1 low-temp-cache=${Math.round(ANALYSIS_CACHE_MS / 3600000)}h`);
