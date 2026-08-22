'use strict';

const axios = require('axios');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_429_RETRIES = Math.max(1, Number(process.env.GEMINI_429_RETRIES || 6));
const RETRY_BUFFER_MS = Math.max(1000, Number(process.env.GEMINI_RETRY_BUFFER_MS || 2500));

// 모든 계정의 Gemini 요청을 한 줄로 세워 순간 burst로 인한 429를 줄인다.
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

  // 응답에 시간이 없을 때만 보수적인 기본값을 사용한다.
  return 30000;
}

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const { getSystemApiSettings } = require('./db');
    const settings = getSystemApiSettings();
    // 관리자 페이지의 기존 공용 AI Key 저장 슬롯을 Gemini용으로 사용한다.
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

async function generateJsonNow({ system = '', text = '', imageUrls = [], maxTokens = 1800, temperature = 0.2 }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API Key가 설정되지 않았습니다. 관리자 페이지 > 서비스 공용 API 설정에서 입력해주세요');

  const parts = [{ text: `${system}\n\n${text}\n\n반드시 유효한 JSON 객체만 출력해.` }];
  for (const url of imageUrls.filter(Boolean).slice(0, 3)) {
    try { parts.push(await imagePart(url)); }
    catch (e) { console.warn(`[Gemini][IMAGE] 다운로드 실패 status=${e.response?.status || '-'} url=${String(url).slice(0,100)}`); }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  for (let attempt = 0; ; attempt++) {
    const waitBefore = cooldownUntil - Date.now();
    if (waitBefore > 0) {
      console.log(`[Gemini][429 COOLDOWN] ${Math.ceil(waitBefore / 1000)}초 대기 후 같은 요청 재개`);
      await sleep(waitBefore);
    }

    try {
      const r = await axios.post(endpoint, {
        contents: [{ parts }],
        generationConfig: { temperature, maxOutputTokens: Math.min(maxTokens, 8192), responseMimeType: 'application/json' }
      }, { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 45000 });

      const raw = r.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (!raw) throw new Error('Gemini 결과가 비어 있습니다');
      return JSON.parse(stripFence(raw));
    } catch (error) {
      if (!is429(error)) throw error;

      const baseWait = retryAfterMs(error);
      const waitMs = baseWait + RETRY_BUFFER_MS;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);

      if (attempt >= MAX_429_RETRIES) {
        console.error(`[Gemini][429] 동일 요청 재시도 한도 초과 attempts=${attempt + 1}`);
        error.isGeminiRateLimit = true;
        throw error;
      }

      console.warn(`[Gemini][429] 소재 실패로 처리하지 않고 같은 요청 유지 · retry=${attempt + 1}/${MAX_429_RETRIES} wait=${Math.ceil(waitMs / 1000)}s`);
    }
  }
}

async function generateJson(options) {
  return enqueue(() => generateJsonNow(options));
}

module.exports = { generateJson, getGeminiApiKey, MODEL };
