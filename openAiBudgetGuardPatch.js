'use strict';

const axios = require('axios');

const originalPost = axios.post.bind(axios);
let queue = Promise.resolve();
let lastStartAt = 0;
const MIN_GAP_MS = Math.max(800, Number(process.env.OPENAI_MIN_GAP_MS || 1600));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isOpenAI(url) { return String(url || '') === 'https://api.openai.com/v1/chat/completions'; }
function errorMessage(e) { return String(e?.response?.data?.error?.message || e?.message || ''); }
function isTpm429(e) { return Number(e?.response?.status || 0) === 429 && /tokens per min|TPM|rate limit reached/i.test(errorMessage(e)); }
function isNoCredits(e) { return Number(e?.response?.status || 0) === 429 && /no credits remaining|add credits/i.test(errorMessage(e)); }

async function runOpenAI(url, data, config) {
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastStartAt));
  if (wait) await sleep(wait);
  lastStartAt = Date.now();

  try {
    return await originalPost(url, data, config);
  } catch (e) {
    if (isNoCredits(e)) {
      // 잔액 소진은 재시도해도 성공하지 않으므로 즉시 종료한다.
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
    return originalPost(url, data, config);
  }
}

axios.post = function budgetGuardedPost(url, data, config) {
  if (!isOpenAI(url)) return originalPost(url, data, config);

  // 모든 OpenAI 요청을 한 줄로 세워 동시 폭주와 TPM 429를 막는다.
  const task = queue.then(() => runOpenAI(url, data, config));
  queue = task.catch(() => {});
  return task;
};

console.log(`[OpenAI][BUDGET GUARD] concurrency=1 minGap=${MIN_GAP_MS}ms TPM429 retry=1 no-credit retry=0`);
