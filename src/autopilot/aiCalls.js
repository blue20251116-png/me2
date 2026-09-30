'use strict';
// AI helpers for the autopilot: per-account key lookup, text and vision calls.
const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('../infra/db');
const { callAI, extractJson, imageBlockFromDataUri } = require('../integrations/aiClient');

function getAiKey(accountId) {
  const a = getAccount(accountId),
    s = getSystemApiSettings();
  return s.anthropic_api_key || process.env.ANTHROPIC_API_KEY || a?.anthropic_api_key || null;
}

async function callAiText(accountId, system, user, { maxTokens = 1800, temperature = 0.55 } = {}) {
  const apiKey = getAiKey(accountId);
  if (!apiKey) throw new Error('Anthropic API 키가 설정되지 않았습니다');
  const raw = await callAI(apiKey, { system, userContent: user, maxTokens, temperature, timeout: 45000 });
  if (!raw) throw new Error('AI 결과가 비어 있습니다');
  return extractJson(raw);
}

async function prepareVisionImageUrls(imageUrls) {
  const out = [];
  for (const raw of (imageUrls || []).filter(Boolean).slice(0, 3)) {
    try {
      if (/^data:image\//i.test(String(raw))) {
        out.push(raw);
        continue;
      }
      const r = await axios.get(String(raw), {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        maxContentLength: 12 * 1024 * 1024,
        maxBodyLength: 12 * 1024 * 1024,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
          referer: 'https://www.threads.com/',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        validateStatus: s => s >= 200 && s < 400,
      });
      const type = String(r.headers?.['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const body = Buffer.from(r.data || []);
      if (!type.startsWith('image/') || body.length < 512) throw new Error('invalid image response');
      out.push('data:' + type + ';base64,' + body.toString('base64'));
      console.log('[AutopilotV3][VISION CACHE] source=' + new URL(String(raw)).hostname + ' bytes=' + body.length);
    } catch (e) {
      console.warn('[AutopilotV3][VISION CACHE] 이미지 로컬화 실패: ' + (e.response?.status || '-') + ' ' + e.message);
    }
  }
  return out;
}

async function callAiVision(accountId, system, text, imageUrls, { maxTokens = 1400, temperature = 0.15 } = {}) {
  const apiKey = getAiKey(accountId);
  if (!apiKey) throw new Error('Anthropic API 키가 설정되지 않았습니다');
  const content = [{ type: 'text', text }];
  const safeImageUrls = await prepareVisionImageUrls(imageUrls);
  if (!safeImageUrls.length) throw new Error('VISION_IMAGE_CACHE_EMPTY');
  for (const dataUri of safeImageUrls) content.push(imageBlockFromDataUri(dataUri));
  const raw = await callAI(apiKey, { system, userContent: content, maxTokens, temperature, timeout: 45000 });
  if (!raw) throw new Error('Vision 결과가 비어 있습니다');
  return extractJson(raw);
}

function clean(v) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEscapedNewlines(v) {
  return String(v || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { getAiKey, callAiText, callAiVision, clean, decodeEscapedNewlines };
