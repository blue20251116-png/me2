'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { budgetState, reserveRequest } = require('./automationState');

// OpenAI 완전히 걷어내고 Claude(Anthropic)로 전환 (2026-09-13): 이 파일이 지키던 안전장치
// (동시성 1 · 최소 간격 · 시간당 호출 상한 · 저온도 분석 캐시 · 입력 글자수 캡)는 프로바이더가
// 바뀌어도 여전히 필요하므로, 감시 대상 URL만 Anthropic 엔드포인트로 옮기고 나머지 로직은
// 그대로 유지한다. 환경변수 이름(OPENAI_*)은 실제 배포 환경(Railway)에 이미 이 이름으로
// 설정돼 있을 수 있어 그대로 두었다 — 이제는 프로바이더 무관 "AI 요청 예산" 설정으로 읽는다.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const originalPost = axios.post.bind(axios);
const inFlight = new Map();
let queue = Promise.resolve();
let lastStartAt = 0;
const MIN_GAP_MS = Math.max(1000, Number(process.env.OPENAI_MIN_GAP_MS || 3000));
const ANALYSIS_CACHE_MS = Math.max(5 * 60 * 1000, Number(process.env.OPENAI_ANALYSIS_CACHE_MS || 24 * 60 * 60 * 1000));
const MAX_REQUESTS_PER_HOUR = Math.max(10, Number(process.env.OPENAI_MAX_REQUESTS_PER_HOUR || 240));
const MAX_TEXT_CHARS = Math.max(6000, Number(process.env.OPENAI_MAX_TEXT_CHARS || 18000));
const analysisCache = new Map();
const MAX_CACHE = 1000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isAnthropic(url) { return String(url || '') === ANTHROPIC_URL; }
function errorMessage(e) { return String(e?.response?.data?.error?.message || e?.message || ''); }
function isTpm429(e) {
  if (Number(e?.response?.status || 0) !== 429) return false;
  const type = String(e?.response?.data?.error?.type || '');
  return /rate_limit/i.test(type) || /tokens per min|TPM|rate limit reached/i.test(errorMessage(e));
}
function isNoCredits(e) {
  const status = Number(e?.response?.status || 0);
  if (status !== 429 && status !== 400) return false;
  return /no credits remaining|add credits|credit balance is too low|insufficient_quota/i.test(errorMessage(e));
}
// REGRESSION (found via review, hourly review, 2026-09-13): the only way this ever computed a
// precise retry delay was parsing OpenAI's specific "please try again in Xs" message text - which
// never appears in an Anthropic 429 response, so every Claude rate-limit hit silently fell back to
// the generic 1800ms default regardless of what the server actually asked for. Anthropic (like
// most REST APIs) returns a standard `retry-after` response header on 429s - reading that first
// gives an accurate wait for the actual provider now in use, while the OpenAI-era text parse stays
// as a harmless fallback for any other API accessed through this file that does phrase it that way.
function retryAfterMs(e) {
  const headerSeconds = Number(e?.response?.headers?.['retry-after']);
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return Math.ceil(headerSeconds * 1000);
  const msg = errorMessage(e);
  const m = msg.match(/try again in\s+([0-9.]+)\s*(ms|s)/i);
  if (m) return m[2].toLowerCase() === 's' ? Math.ceil(Number(m[1]) * 1000) : Math.ceil(Number(m[1]));
  return 1800;
}
function isCacheableAnalysis(data) {
  const t = Number(data?.temperature);
  return Number.isFinite(t) && t <= 0.2 && Array.isArray(data?.messages);
}
function cacheKey(data) {
  const stable = JSON.stringify({
    model: data?.model,
    temperature: data?.temperature,
    max_tokens: data?.max_tokens,
    system: data?.system,
    messages: data?.messages,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}
function pruneCache() {
  const now = Date.now();
  for (const [k, v] of analysisCache) if (now - v.at > ANALYSIS_CACHE_MS) analysisCache.delete(k);
  while (analysisCache.size > MAX_CACHE) analysisCache.delete(analysisCache.keys().next().value);
}
function assertHourlyBudget() {
  const state = budgetState();
  if (state.available) return;
  // Error code/flag names kept as OPENAI_* even after the Claude migration: this exact code/flag
  // is checked directly by geminiEmergencyFallbackPatch.js, scheduler.js (formerly
  // autopilotTimedPrefillPatch.js), automationState.js, and autopilotMaterialEngine.js/
  // recipeQualityPatch.js's own catch blocks (formerly injected by runtimeStabilityPatch.js,
  // now baked in directly) - renaming here without touching all of them would silently break
  // the no-retry-on-budget-exceeded behavior everywhere else.
  const e = new Error(`OPENAI_HOURLY_BUDGET_EXCEEDED: ${state.used}/${state.limit} requests in last hour`);
  e.code = 'OPENAI_HOURLY_BUDGET_EXCEEDED';
  e.__openAiNoRetry = true;
  e.retryAt = state.retryAt;
  console.warn(`[AI][HARD BUDGET] hourly cap reached ${state.used}/${state.limit} retryAt=${new Date(state.retryAt).toISOString()}`);
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
// REGRESSION (found via synthetic testing, hourly review): head/tail had hardcoded MINIMUMS
// (1000/500) that ignored `max` entirely once `max` dropped below ~1500 - truncateString(text, 200)
// still returned ~1548 chars. capContent() calls this per-field with a shrinking shared budget
// (MAX_TEXT_CHARS - state.used so far), so once earlier fields in a multi-field request had
// consumed most of the budget, every later large field would still emit ~1500+ chars regardless
// of how little budget remained - silently letting a request blow well past MAX_TEXT_CHARS in
// exactly the cost-control path this file exists to enforce. Below a small `max`, this now falls
// back to a plain slice (a head/tail split isn't meaningful at that size anyway); otherwise the
// head/tail split is sized as a share of `max` itself, so the returned string never exceeds it.
function truncateString(s, max) {
  const text = String(s || '');
  if (text.length <= max) return text;
  if (max <= 50) return text.slice(0, Math.max(0, max));
  const markerLen = 70;
  const available = Math.max(0, max - markerLen);
  const head = Math.floor(available * 0.72);
  const tail = available - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n...[AI cost guard truncated ${dropped} chars]...\n${text.slice(-tail)}`;
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
// REGRESSION (found during the OpenAI->Claude migration, 2026-09-13): OpenAI puts the system
// prompt inside messages[] as a {role:'system'} entry, but Anthropic's Messages API sends it as
// a separate top-level `system` string - often the LARGEST single field (voiceGuide() alone runs
// to several thousand characters). This function used to only walk `data.messages`, so switching
// to Claude would have silently stopped counting/capping the system prompt entirely, defeating
// the cost cap this file exists to enforce for exactly the biggest field in most requests.
function capRequestText(data) {
  if (!data) return data;
  const before = countTextChars({ system: data.system, messages: data.messages });
  if (before <= MAX_TEXT_CHARS) return data;
  const state = { used: 0 };
  const cloned = { ...data };
  if (data.system) cloned.system = capContent(data.system, state);
  if (Array.isArray(data.messages)) cloned.messages = capContent(data.messages, state);
  const after = countTextChars({ system: cloned.system, messages: cloned.messages });
  console.warn(`[AI][INPUT CAP] text chars ${before} -> ${after} cap=${MAX_TEXT_CHARS}`);
  return cloned;
}

// OpenAI's image_url.detail ('low'/'high'/'auto') let this file force cheaper, lower-resolution
// vision analysis - Anthropic's image content blocks ({type:'image', source:{...}}) have no
// equivalent per-image quality knob, so there is nothing to mutate here anymore. Kept as a
// no-op observability counter (still useful in the usage log) rather than deleting the concept
// outright, since a future provider swap may reintroduce a similar knob.
function countImages(data) {
  if (!data || !Array.isArray(data.messages)) return 0;
  let count = 0;
  for (const message of data.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) if (part?.type === 'image') count++;
  }
  return count;
}

function classifyPurpose(data) {
  const text = [
    typeof data?.system === 'string' ? data.system : '',
    Array.isArray(data?.messages) ? data.messages.map(m => typeof m?.content === 'string' ? m.content : '').join('\n') : '',
  ].join('\n').slice(0, 12000);
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
    usage.cache_read_input_tokens ||
    0
  );
  const uncached = Math.max(0, prompt - cached);
  const chars = countTextChars({ system: data?.system, messages: data?.messages });
  const purpose = classifyPurpose(data);
  const images = countImages(data);
  const model = String(response?.data?.model || data?.model || 'unknown');
  console.log(`[AI][USAGE] purpose=${purpose} model=${model} attempt=${attempt} input=${prompt} cached=${cached} uncached=${uncached} output=${completion} total=${total} textChars=${chars} images=${images}`);
}

async function runGuardedRequest(url, rawData, config) {
  // A response timeout alone does not bound DNS/connect/TLS stalls.
  const timeout = Number(config?.timeout) > 0 ? Math.min(Number(config.timeout), 60000) : 60000;
  config = { ...config, timeout, signal: config?.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) };
  const data = capRequestText(rawData);
  let key = null;
  if (isCacheableAnalysis(data)) {
    key = cacheKey(data);
    const hit = analysisCache.get(key);
    if (hit && Date.now() - hit.at <= ANALYSIS_CACHE_MS) {
      console.log('[AI][ANALYSIS CACHE HIT] request reused');
      return hit.response;
    }
  }

  assertHourlyBudget();
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastStartAt));
  if (wait) await sleep(wait);
  assertHourlyBudget();
  lastStartAt = Date.now();
  reserveRequest();

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

    let retryMs = Math.max(1500, Math.min(6000, retryAfterMs(e) + 500));
    console.warn(`[AI][RATE LIMIT GUARD] 429 → ${retryMs}ms 대기 후 1회 재시도`);
    await sleep(retryMs);
    assertHourlyBudget();
    lastStartAt = Date.now();
    reserveRequest();
    attempt = 2;
    response = await originalPost(url, data, config);
  }

  if (response) logUsage(response, data, attempt);

  if (key && response) {
    analysisCache.set(key, { at: Date.now(), response });
    pruneCache();
    console.log(`[AI][ANALYSIS CACHE SAVE] ttl=${Math.round(ANALYSIS_CACHE_MS / 3600000)}h size=${analysisCache.size}`);
  }
  return response;
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

axios.post = function dedupedBudgetGuardedPost(url, data, config) {
  if (!isAnthropic(url)) return originalPost(url, data, config);

  const key = requestKey(data, config);
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[AI][IN-FLIGHT DEDUPE] key=${key.slice(0,10)} reused=yes`);
    return existing;
  }

  const task = queue.then(() => runGuardedRequest(url, data, config)).finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  queue = task.catch(() => {});
  inFlight.set(key, task);
  return task;
};

console.log(`[AI][IN-FLIGHT DEDUPE] enabled target=${ANTHROPIC_URL}; identical concurrent requests share one credential-scoped budgeted call`);
console.log(`[AI][BUDGET GUARD] target=${ANTHROPIC_URL} concurrency=1 minGap=${MIN_GAP_MS}ms hourlyCap=${MAX_REQUESTS_PER_HOUR} textCap=${MAX_TEXT_CHARS}chars cache<=0.2 ttl=${Math.round(ANALYSIS_CACHE_MS / 3600000)}h`);

module.exports = { truncateString, capContent, countTextChars, capRequestText, MAX_TEXT_CHARS, retryAfterMs };
