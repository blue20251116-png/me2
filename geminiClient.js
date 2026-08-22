'use strict';

const axios = require('axios');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_INLINE_WAIT_MS = Math.max(1000, Number(process.env.GEMINI_MAX_INLINE_WAIT_MS || 10000));
const RETRY_BUFFER_MS = Math.max(1000, Number(process.env.GEMINI_RETRY_BUFFER_MS || 2500));

let requestQueue = Promise.resolve();
let cooldownUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function enqueue(task) {
  const run = requestQueue.then(task, task);
  requestQueue = run.catch(() => {});
  return run;
}

function is429(error) {
  return Number(error?.response?.status) === 429 || /(?:quota exceeded|rate limit|too many requests|\b429\b)/i.test(String(error?.message || error?.response?.data?.error?.message || ''));
}

function retryAfterMs(error) {
  const header = error?.response?.headers?.['retry-after'];
  if (header != null) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const dateMs = Date.parse(String(header));
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  let payload = '';
  try { payload = JSON.stringify(error?.response?.data || ''); } catch {}
  const text = `${error?.message || ''} ${error?.response?.data?.error?.message || ''} ${payload}`;
  const m = text.match(/(?:please\s+retry\s+in|retry\s+in)\s*([0-9]+(?:\.[0-9]+)?)\s*s/i);
  if (m) return Math.ceil(Number(m[1]) * 1000);
  return 30000;
}

function setCooldown(until) {
  cooldownUntil = Math.max(cooldownUntil, Number(until) || 0);
  global.__ME2_GEMINI_COOLDOWN_UNTIL = cooldownUntil;
  return cooldownUntil;
}

function clearCooldown() {
  cooldownUntil = 0;
  delete global.__ME2_GEMINI_COOLDOWN_UNTIL;
}

function makeCooldownError(error, until) {
  error.isGeminiRateLimit = true;
  error.geminiCooldownUntil = until;
  error.code = 'GEMINI_COOLDOWN';
  return error;
}

function getCooldownUntil() {
  const globalUntil = Number(global.__ME2_GEMINI_COOLDOWN_UNTIL || 0);
  const until = Math.max(cooldownUntil, globalUntil);
  if (until > Date.now()) return until;
  if (until) clearCooldown();
  return 0;
}

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const { getSystemApiSettings } = require('./db');
    const settings = getSystemApiSettings();
    return settings.openai_api_key || '';
  } catch {
    return '';
  }
}

function stripFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function imagePart(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  const mime = String(r.headers?.['content-type'] || 'image/jpeg').split(';')[0];
  return { inlineData: { mimeType: mime.startsWith('image/') ? mime : 'image/jpeg', data: Buffer.from(r.data).toString('base64') } };
}

async function doRequest({ endpoint, apiKey, parts, maxTokens, temperature }) {
  const r = await axios.post(endpoint, {
    contents: [{ parts }],
    generationConfig: { temperature, maxOutputTokens: Math.min(maxTokens, 8192), responseMimeType: 'application/json' }
  }, { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 45000 });
  const raw = r.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!raw) throw new Error('Gemini 결과가 비어 있습니다');
  return JSON.parse(stripFence(raw));
}

async function generateJsonNow({ system = '', text = '', imageUrls = [], maxTokens = 1800, temperature = 0.2 }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API Key가 설정되지 않았습니다. 관리자 페이지 > 서비스 공용 API 설정에서 입력해주세요');

  const activeCooldown = getCooldownUntil();
  if (activeCooldown) {
    const e = new Error(`Gemini cooldown active until ${new Date(activeCooldown).toISOString()}`);
    console.log(`[Gemini][COOLDOWN SKIP] 기다리지 않고 즉시 계정 보충으로 넘김 · until=${new Date(activeCooldown).toISOString()}`);
    throw makeCooldownError(e, activeCooldown);
  }

  const parts = [{ text: `${system}\n\n${text}\n\n반드시 유효한 JSON 객체만 출력해.` }];
  for (const url of imageUrls.filter(Boolean).slice(0, 3)) {
    try { parts.push(await imagePart(url)); }
    catch (e) { console.warn(`[Gemini][IMAGE] 다운로드 실패 status=${e.response?.status || '-'} url=${String(url).slice(0,100)}`); }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    return await doRequest({ endpoint, apiKey, parts, maxTokens, temperature });
  } catch (error) {
    if (!is429(error)) throw error;

    const waitMs = retryAfterMs(error) + RETRY_BUFFER_MS;
    setCooldown(Date.now() + waitMs);

    if (waitMs <= MAX_INLINE_WAIT_MS) {
      console.warn(`[Gemini][429 QUICK RETRY] 같은 요청 1회만 짧게 재시도 · wait=${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
      try {
        const result = await doRequest({ endpoint, apiKey, parts, maxTokens, temperature });
        clearCooldown();
        return result;
      } catch (retryError) {
        if (!is429(retryError)) throw retryError;
        const retryWait = retryAfterMs(retryError) + RETRY_BUFFER_MS;
        setCooldown(Date.now() + retryWait);
        console.warn(`[Gemini][429 DEFER] 짧은 재시도도 제한됨 → 기다리지 않고 계정 보충대기로 전환 · wait=${Math.ceil(retryWait / 1000)}s`);
        throw makeCooldownError(retryError, getCooldownUntil());
      }
    }

    console.warn(`[Gemini][429 DEFER] ${Math.ceil(waitMs / 1000)}초를 여기서 기다리지 않고 계정 보충대기로 전환`);
    throw makeCooldownError(error, getCooldownUntil());
  }
}

async function generateJson(options) {
  return enqueue(() => generateJsonNow(options));
}

module.exports = { generateJson, getGeminiApiKey, getCooldownUntil, MODEL };
