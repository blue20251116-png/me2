'use strict';

const axios = require('axios');
const gemini = require('./geminiClient');
const originalPost = axios.post.bind(axios);

axios.post = async function(url, data, config) {
  if (typeof url !== 'string' || !url.includes('api.openai.com/v1/chat/completions') || !gemini.getGeminiApiKey()) {
    return originalPost(url, data, config);
  }

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  let system = '';
  let text = '';
  const imageUrls = [];

  for (const message of messages) {
    if (message?.role === 'system' && typeof message.content === 'string') system += `${message.content}\n`;
    if (typeof message?.content === 'string' && message.role !== 'system') text += `${message.content}\n`;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === 'text') text += `${part.text || ''}\n`;
        if (part?.type === 'image_url' && part.image_url?.url) imageUrls.push(part.image_url.url);
      }
    }
  }

  const result = await gemini.generateJson({
    system,
    text,
    imageUrls,
    maxTokens: Number(data?.max_tokens) || 1800,
    temperature: Number.isFinite(Number(data?.temperature)) ? Number(data.temperature) : 0.2
  });

  console.log(`[GeminiCompat] 기존 AI 호출 대체 성공 model=${gemini.MODEL} images=${imageUrls.length}`);
  return { data: { choices: [{ message: { content: JSON.stringify(result) } }] } };
};

console.log(`[GeminiCompat] 활성화 key=${gemini.getGeminiApiKey() ? 'configured' : 'missing'} model=${gemini.MODEL}`);
