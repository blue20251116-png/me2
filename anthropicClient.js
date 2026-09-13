'use strict';
const axios = require('axios');

// Shared by every module that used to call OpenAI's chat/completions endpoint
// (aiCaption.js, frameVision.js, autopilotMaterialEngine.js, threadsMaterialWriter.js,
// contentOnlyAutomation.js, recipeQualityPatch.js) - centralizing this avoids the
// stale-copy drift this session has already found and fixed multiple times elsewhere
// (e.g. DANGLING_BOUND_NOUN_START used to be copy-pasted between two files).
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function extractText(res) {
  const textBlock = res.data?.content?.find((block) => block.type === 'text');
  return textBlock?.text || '';
}

// Anthropic has no OpenAI-style response_format:{type:'json_object'} that guarantees
// valid JSON at the API level - callers instead instruct the model (in the system/user
// prompt) to output JSON only, and this strips common wrapping (```json fences, stray
// prose) before parsing, with a bracket-extraction fallback for when the model still
// adds a sentence before/after the JSON itself.
function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  // REGRESSION (found via review, hourly review, 2026-09-13): this used to try the array pattern
  // FIRST. Nearly every JSON schema this app asks Claude for is a top-level OBJECT that itself
  // contains an array value ({"items":[...]}, {"searchTerms":[...]}, {"queries":[...]}, etc.) -
  // whenever the model wraps its answer in any surrounding text (breaking the direct parse
  // above), the array-first regex greedily matched just the INNER array substring and parsed it
  // successfully on its own, returning early with only the array and silently discarding the
  // object it actually belonged to (e.g. {"items":[{"text":"a"}]} -> [{"text":"a"}], losing the
  // "items" key entirely). Callers reading parsed.items off that then saw undefined and treated
  // the whole response as empty. Trying the object pattern first fixes this without breaking the
  // one real bare-top-level-array schema in this app (frameVision.js's frame list): an object
  // match spanning multiple comma-separated array elements isn't valid JSON on its own, so it
  // fails to parse and correctly falls through to the array check below.
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

// userContent may be a plain string or an array of Anthropic content blocks (for vision).
async function callAnthropic(apiKey, { system, userContent, model = DEFAULT_MODEL, maxTokens = 1200, temperature = 0.7, timeout = 30000 } = {}) {
  if (!apiKey) throw new Error('Anthropic API 키가 설정되지 않았습니다');
  const res = await axios.post(
    ANTHROPIC_URL,
    {
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: userContent }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
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

function imageBlock(url) {
  return { type: 'image', source: { type: 'url', url } };
}

// Some callers pre-download+base64 an image themselves (bypassing hotlink protection, caching
// the bytes, etc. - see autopilotMaterialEngine.js's prepareVisionImageUrls) and end up with a
// "data:image/...;base64,..." string instead of a fetchable URL. Anthropic's "url" source type
// expects an actual http(s) URL, not a data URI, so those need the "base64" source type instead.
function imageBlockFromDataUri(dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUri || ''));
  if (!m) throw new Error('유효한 data URI 이미지가 아닙니다');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

module.exports = {
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MODEL,
  callAnthropic,
  callAnthropicJson,
  extractText,
  extractJson,
  imageBlock,
  imageBlockFromDataUri,
};
