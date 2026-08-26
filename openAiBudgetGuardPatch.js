'use strict';

const axios = require('axios');
const crypto = require('crypto');

const originalPost = axios.post.bind(axios);
let queue = Promise.resolve();
let lastStartAt = 0;
const MIN_GAP_MS = Math.max(1000, Number(process.env.OPENAI_MIN_GAP_MS || 3000));
const ANALYSIS_CACHE_MS = Math.max(5 * 60 * 1000, Number(process.env.OPENAI_ANALYSIS_CACHE_MS || 24 * 60 * 60 * 1000));
const MAX_REQUESTS_PER_HOUR = Math.max(10, Number(process.env.OPENAI_MAX_REQUESTS_PER_HOUR || 240));
const MAX_TEXT_CHARS = Math.max(6000, Number(process.env.OPENAI_MAX_TEXT_CHARS || 18000));
const VISION_DETAIL = /^(low|high|auto)$/i.test(String(process.env.OPENAI_VISION_DETAIL || 'low'))
  ? String(process.env.OPENAI_VISION_DETAIL || 'low').toLowerCase()
  : 'low';
const analysisCache = new Map();
const MAX_CACHE = 1000;
const requestTimes = [];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isOpenAI(url) { return String(url || '') === 'https://api.openai.com/v1/chat/completions'; }
function errorMessage(e) { return String(e?.response?.data?.error?.message || e?.message || ''); }
function isTpm429(e) { return Number(e?.response?.status || 0) === 429 && /tokens per min|TPM|rate limit reached/i.test(errorMessage(e)); }
function isNoCredits(e) { return Number(e?.response?.status || 0) === 429 && /no credits remaining|add credits/i.test(errorMessage(e)); }
function isCacheableAnalysis(data) {
  const t = Number(data?.temperature);
  return Number.isFinite(t) && t <= 0.2 && Array.isArray(data?.messages);
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
function pruneRequestTimes(now = Date.now()) {
  const cutoff = now - 60 * 60 * 1000;
  while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
}
function assertHourlyBudget() {
  const now = Date.now();
  pruneRequestTimes(now);
  if (requestTimes.length < MAX_REQUESTS_PER_HOUR) return;
  const e = new Error(`OPENAI_HOURLY_BUDGET_EXCEEDED: ${requestTimes.length}/${MAX_REQUESTS_PER_HOUR} requests in last hour`);
  e.code = 'OPENAI_HOURLY_BUDGET_EXCEEDED';
  e.__openAiNoRetry = true;
  console.warn(`[OpenAI][HARD BUDGET] hourly cap reached ${requestTimes.length}/${MAX_REQUESTS_PER_HOUR} → new AI generation blocked`);
  throw e;
}
function countTextChars(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countTextChars(v), 0);
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const [k, v] of Object.entries(value)) {
    if (/image_url|url/i.test(k) && typeof v === 'string') continue;
    total += countTextChars(v);
  }
  return total;
}
function truncateString(s, max) {
  const text = String(s || '');
  if (text.length <= max) return text;
  const head = Math.max(1000, Math.floor(max * 0.72));
  const tail = Math.max(500, max - head - 80);
  return `${text.slice(0, head)}\n...[OpenAI cost guard truncated ${text.length - head - tail} chars]...\n${text.slice(-tail)}`;
}
function capContent(value, state) {
  if (typeof value === 'string') {
    const remaining = Math.max(0, MAX_TEXT_CHARS - state.used);
    if (!remaining) return '';
    const next = truncateString(value, remaining);
    state.used += next.length;
    return next;
  }
  if (Array.isArray(value)) return value.map(v => capContent(v, state));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/image_url|url/i.test(k)) out[k] = v;
    else out[k] = capContent(v, state);
  }
  return out;
}
function capRequestText(data) {
  if (!data || !Array.isArray(data.messages)) return data;
  const before = countTextChars(data.messages);
  if (before <= MAX_TEXT_CHARS) return data;
  const cloned = { ...data, messages: capContent(data.messages, { used: 0 }) };
  const after = countTextChars(cloned.messages);
  console.warn(`[OpenAI][INPUT CAP] text chars ${before} -> ${after} cap=${MAX_TEXT_CHARS}`);
  return cloned;
}

function applyVisionCostGuard(data) {
  if (!data || !Array.isArray(data.messages)) return data;
  let imageCount = 0;
  let changed = false;
  const messages = data.messages.map(message => {
    if (!Array.isArray(message?.content)) return message;
    const content = message.content.map(part => {
      if (part?.type !== 'image_url' || !part?.image_url?.url) return part;
      imageCount += 1;
      const current = String(part.image_url.detail || '').toLowerCase();
      if (current === VISION_DETAIL) return part;
      changed = true;
      return { ...part, image_url: { ...part.image_url, detail: VISION_DETAIL } };
    });
    return { ...message, content };
  });
  if (imageCount) {
    console.log(`[OpenAI][VISION COST GUARD] images=${imageCount} detail=${VISION_DETAIL}${changed ? ' applied=yes' : ' applied=no'}`);
  }
  return changed ? { ...data, messages } : data;
}

function classifyPurpose(data) {
  const text = Array.isArray(data?.messages)
    ? data.messages.map(m => typeof m?.content === 'string' ? m.content : '').join('\n').slice(0, 12000)
    : '';
  if (/YouTube.*검색|검색할 핵심 키워드|YouTube 검색 키워드/i.test(text)) return 'youtube_keyword';
  if (/쿠팡.*검색.*키워드|상품 키워드.*제안|검색 키워드 5개/i.test(text)) return 'product_keyword';
  if (/이미지|사진|vision|보이는 상품|영상 프레임/i.test(text)) return 'vision_analysis';
  if (/레시피|재료|조리|요리/i.test(text)) return 'recipe_or_food';
  if (/Threads|쓰레드|게시물|본문|말투|문체/i.test(text)) return 'post_generation';
  return 'other';
}
function logUsage(response, data, attempt = 1) {
  const usage = response?.data?.usage || {};
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const total = Number(usage.total_tokens || (prompt + completion) || 0);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ||
    usage.input_tokens_details?.cached_tokens ||
    0
  );
  const uncached = Math.max(0, prompt - cached);
  const chars = countTextChars(data?.messages || []);
  const purpose = classifyPurpose(data);
  const model = String(response?.data?.model || data?.model || 'unknown');
  console.log(`[OpenAI][USAGE] purpose=${purpose} model=${model} attempt=${attempt} input=${prompt} cached=${cached} uncached=${uncached} output=${completion} total=${total} textChars=${chars}`);
}

async function runOpenAI(url, rawData, config) {
  const data = applyVisionCostGuard(capRequestText(rawData));
  let key = null;
  if (isCacheableAnalysis(data)) {
    key = cacheKey(data);
    const hit = analysisCache.get(key);
    if (hit && Date.now() - hit.at <= ANALYSIS_CACHE_MS) {
      console.log('[OpenAI][ANALYSIS CACHE HIT] request reused');
      return hit.response;
    }
  }

  assertHourlyBudget();
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastStartAt));
  if (wait) await sleep(wait);
  assertHourlyBudget();
  lastStartAt = Date.now();
  requestTimes.push(lastStartAt);

  let response;
  let attempt = 1;
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
    retryMs = Math.max(1500, Math.min(6000, retryMs + 500));
    console.warn(`[OpenAI][TPM GUARD] 429 → ${retryMs}ms 대기 후 1회 재시도`);
    await sleep(retryMs);
    assertHourlyBudget();
    lastStartAt = Date.now();
    requestTimes.push(lastStartAt);
    attempt = 2;
    response = await originalPost(url, data, config);
  }

  if (response) logUsage(response, data, attempt);

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

console.log(`[OpenAI][BUDGET GUARD] concurrency=1 minGap=${MIN_GAP_MS}ms hourlyCap=${MAX_REQUESTS_PER_HOUR} textCap=${MAX_TEXT_CHARS}chars visionDetail=${VISION_DETAIL} cache<=0.2 ttl=${Math.round(ANALYSIS_CACHE_MS / 3600000)}h`);
