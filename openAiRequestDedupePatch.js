'use strict';

const axios = require('axios');
const crypto = require('crypto');

// OpenAI 완전히 걷어내고 Claude(Anthropic)로 전환 (2026-09-13): 감시 대상 URL만 옮기고 나머지
// 동시-중복요청 dedupe 로직은 유지한다.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const guardedPost = axios.post.bind(axios);
const inFlight = new Map();

function isAnthropic(url) {
  return String(url || '') === ANTHROPIC_URL;
}

// REGRESSION (found during the OpenAI->Claude migration, 2026-09-13): OpenAI's auth header is
// `Authorization: Bearer <key>`, but Anthropic uses `x-api-key: <key>` instead - this function only
// ever read `Authorization`, so every Anthropic request hashed the SAME empty string as its
// "credential scope" regardless of which account's key was actually used. That would have let two
// different accounts' concurrent identical-content requests collapse into one shared in-flight
// call, silently dropping the per-credential isolation this dedupe was designed to have.
function requestKey(data, config) {
  const credential = String(
    config?.headers?.['x-api-key'] || config?.headers?.Authorization || config?.headers?.authorization || ''
  );
  const credentialScope = crypto.createHash('sha256').update(credential).digest('hex');
  const stable = JSON.stringify({
    credentialScope,
    model: data?.model,
    temperature: data?.temperature,
    max_tokens: data?.max_tokens,
    system: data?.system,
    messages: data?.messages,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

axios.post = function dedupedAiPost(url, data, config) {
  if (!isAnthropic(url)) return guardedPost(url, data, config);

  const key = requestKey(data, config);
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[AI][IN-FLIGHT DEDUPE] key=${key.slice(0,10)} reused=yes`);
    return existing;
  }

  const task = Promise.resolve()
    .then(() => guardedPost(url, data, config))
    .finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
};

console.log(`[AI][IN-FLIGHT DEDUPE] enabled target=${ANTHROPIC_URL}; identical concurrent requests share one credential-scoped budgeted call`);
