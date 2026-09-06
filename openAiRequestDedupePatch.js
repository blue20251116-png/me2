'use strict';

const axios = require('axios');
const crypto = require('crypto');

const guardedPost = axios.post.bind(axios);
const inFlight = new Map();

function isOpenAI(url) {
  return String(url || '') === 'https://api.openai.com/v1/chat/completions';
}

function requestKey(data, config) {
  const authorization = String(config?.headers?.Authorization || config?.headers?.authorization || '');
  const credentialScope = crypto.createHash('sha256').update(authorization).digest('hex');
  const stable = JSON.stringify({
    credentialScope,
    model: data?.model,
    temperature: data?.temperature,
    max_tokens: data?.max_tokens,
    response_format: data?.response_format,
    messages: data?.messages,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

axios.post = function dedupedOpenAiPost(url, data, config) {
  if (!isOpenAI(url)) return guardedPost(url, data, config);

  const key = requestKey(data, config);
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[OpenAI][IN-FLIGHT DEDUPE] key=${key.slice(0,10)} reused=yes`);
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

console.log('[OpenAI][IN-FLIGHT DEDUPE] enabled; identical concurrent requests share one credential-scoped budgeted call');
