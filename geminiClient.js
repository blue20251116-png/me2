'use strict';

const axios = require('axios');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

function stripFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function imagePart(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  const mime = String(r.headers?.['content-type'] || 'image/jpeg').split(';')[0];
  return { inlineData: { mimeType: mime.startsWith('image/') ? mime : 'image/jpeg', data: Buffer.from(r.data).toString('base64') } };
}

async function generateJson({ system = '', text = '', imageUrls = [], maxTokens = 1800, temperature = 0.2 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');

  const parts = [{ text: `${system}\n\n${text}\n\n반드시 유효한 JSON 객체만 출력해.` }];
  for (const url of imageUrls.filter(Boolean).slice(0, 3)) {
    try { parts.push(await imagePart(url)); }
    catch (e) { console.warn(`[Gemini][IMAGE] 다운로드 실패 status=${e.response?.status || '-'} url=${String(url).slice(0,100)}`); }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await axios.post(endpoint, {
    contents: [{ parts }],
    generationConfig: { temperature, maxOutputTokens: Math.min(maxTokens, 8192), responseMimeType: 'application/json' }
  }, { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = r.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!raw) throw new Error('Gemini 결과가 비어 있습니다');
  return JSON.parse(stripFence(raw));
}

module.exports = { generateJson, MODEL };
