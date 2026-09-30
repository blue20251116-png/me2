'use strict';
const axios = require('axios');

// REVERTED 2026-09-16 (user request, after Claude API cost became unaffordable):
// this file used to call Anthropic's Messages API. It now calls OpenAI's chat/completions
// endpoint again, but keeps the file name and every exported function name unchanged
// (callAnthropic/callAnthropicJson/imageBlock/imageBlockFromDataUri) so none of its 6
// callers (aiCaption.js, contentOnlyAutomation.js, autopilotMaterialEngine.js,
// threadsMaterialWriter.js, recipeQualityPatch.js, frameVision.js) or their tests need to
// change - the same "keep the established name, swap the target" precedent this codebase
// already used in openAiBudgetGuardPatch.js when it moved the other direction on 2026-09-13.
// openAiBudgetGuardPatch.js's own ANTHROPIC_URL constant was updated to match this file's URL.
const ANTHROPIC_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

function extractText(res) {
  return res.data?.choices?.[0]?.message?.content || '';
}

// OpenAI has a response_format:{type:'json_object'} that guarantees valid JSON at the API
// level, but callers here build the same {system, userContent} shape either provider could
// use, so this still instructs the model via prompt text and cleans up the response the
// same way regardless. Kept identical to the pre-2026-09-16 Anthropic version, including its
// object-before-array match order (see the regression note in the test file): nearly every
// JSON schema this app asks for is a top-level OBJECT that itself contains an array value
// ({"items":[...]}), so trying the array pattern first would greedily match just the inner
// array and silently discard the object it belongs to whenever the model adds surrounding text.
function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {}
  }
  throw new Error('AI 응답을 JSON으로 해석할 수 없습니다');
}

// `apiKey` is whatever the caller resolved via its own `shared.anthropic_api_key ||
// process.env.ANTHROPIC_API_KEY || account?.anthropic_api_key` chain - those DB/env names
// are stale leftovers from the 2026-09-13 OpenAI->Claude migration (left alone here to avoid
// a wider DB/dashboard rename) and may still hold an actual `sk-ant-...` Claude key from
// that period, or nothing, or (if an admin/member already worked around the stale label) a
// real OpenAI key. Only override with the shared OPENAI_API_KEY when the resolved key is
// missing or is shaped like an Anthropic key - preserves legitimate per-account/shared-key
// override behavior for anyone who already pasted a working OpenAI key into that field,
// while not sending a Claude-shaped key to OpenAI (which would just 401).
function looksLikeAnthropicKey(k) {
  return typeof k === 'string' && k.startsWith('sk-ant-');
}

// userContent may be a plain string or an array of OpenAI content parts (for vision).
async function callAnthropic(apiKey, { system, userContent, model = DEFAULT_MODEL, maxTokens = 1200, temperature = 0.7, timeout = 30000 } = {}) {
  const key = (!apiKey || looksLikeAnthropicKey(apiKey)) ? (process.env.OPENAI_API_KEY || apiKey) : apiKey;
  if (!key) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });
  const res = await axios.post(
    ANTHROPIC_URL,
    { model, max_tokens: maxTokens, temperature, messages },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      timeout,
    }
  );
  const text = extractText(res);
  if (!text) throw new Error('AI로부터 응답을 받지 못했습니다');
  return text;
}

async function callAnthropicJson(apiKey, options) {
  const text = await callAnthropic(apiKey, options);
  return extractJson(text);
}

// Cost (2026-09-24, user: "오픈api 비용이 너무많이들어"): with no `detail`, OpenAI uses "auto",
// which bills a typical 1080px Threads photo as high-detail - on gpt-4o-mini that is ~25,000 input
// tokens per image vs a flat 2,833 at "low". Every image this app sends (autopilot post analysis,
// up to 3 images per post; the content-only path; the manual frame analyzer, 8-15 frames per
// call) is for identifying what a product/dish/scene is, which low detail (512px) handles fine.
// Set OPENAI_IMAGE_DETAIL=high (or auto) to opt back in if small on-image text ever needs reading.
const IMAGE_DETAIL = ['low', 'high', 'auto'].includes(process.env.OPENAI_IMAGE_DETAIL) ? process.env.OPENAI_IMAGE_DETAIL : 'low';

function imageBlock(url) {
  return { type: 'image_url', image_url: { url, detail: IMAGE_DETAIL } };
}

// OpenAI accepts a data: URI directly in image_url.url (unlike Anthropic, which needed a
// separate base64 source type) - this just validates the shape and passes it through.
function imageBlockFromDataUri(dataUri) {
  if (!/^data:[^;]+;base64,.+/s.test(String(dataUri || ''))) throw new Error('유효한 data URI 이미지가 아닙니다');
  return { type: 'image_url', image_url: { url: dataUri, detail: IMAGE_DETAIL } };
}

module.exports = {
  ANTHROPIC_URL,
  DEFAULT_MODEL,
  callAnthropic,
  callAnthropicJson,
  extractText,
  extractJson,
  imageBlock,
  imageBlockFromDataUri,
  looksLikeAnthropicKey,
};
