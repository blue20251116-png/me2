'use strict';

const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const system = getSystemApiSettings();
  return system.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || 'gemini-compat';
}

function cleanBody(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function needsNaturalRewrite(text) {
  const body = cleanBody(text);
  if (!body) return false;
  const lines = body.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length <= 2) return true;
  if (lines.some((x) => x.length > 42)) return true;
  if (/왜\s*감\s+\S/.test(body)) return true;
  if (lines.some((x) => /^(진짜|그냥|근데|그래서|그리고|이거)$/.test(x))) return true;
  return false;
}

async function rewriteBody(accountId, currentText) {
  const key = getOpenAIKey(accountId);
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.78,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `너는 한국 Threads 본문만 최종 다듬는 편집기다\n댓글은 절대 생성하거나 수정하지 않는다\n\n목표\n- 실제 사람이 바로 쓴 것처럼 짧고 자연스럽게\n- 설명문보다 첫 반응과 감정을 앞에 둔다\n- 의미가 끝나는 지점에서만 줄바꿈한다\n- 3~6줄 우선\n- 마침표와 쉼표는 쓰지 않는다\n- ㅋㅋ ㅋㅋㅋ 같은 표현은 문맥에 맞을 때만 1~2회 사용한다\n- 존댓말 금지\n- ~냐 금지\n- 음슴체 금지\n- ~더라 ~더라고 계열 금지\n- 광고 카피 같은 표현 금지\n- 입력에 없는 구매 경험 사용 경험 주변인 반응 사실을 새로 만들지 않는다\n- 제품명 재료명 핵심 사실은 바꾸지 않는다\n\n좋은 예시\n와인바 왜 감ㅋㅋ\n치즈에 페퍼로니 이 조합 미쳤네\n\n한입 먹고\n바로 와인 생각남ㅋㅋ\n\nJSON만 출력\n{"text":""}`
        },
        {
          role: 'user',
          content: `[현재 본문]\n${currentText}\n\n본문만 자연스럽게 고쳐라\n댓글이나 링크 문구는 만들지 마라`
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      timeout: 30000
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return cleanBody(parsed.text || currentText);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  const current = cleanBody(result.text);
  if (!needsNaturalRewrite(current)) return { ...result, text: current };

  try {
    const rewritten = await rewriteBody(accountId, current);
    if (!rewritten) return { ...result, text: current };
    console.log(`[AutopilotV3][BODY TONE] rewrite preview="${rewritten.slice(0, 160).replace(/\n/g, ' / ')}"`);
    return { ...result, text: rewritten };
  } catch (error) {
    console.warn(`[AutopilotV3][BODY TONE] rewrite skipped error=${error.response?.data?.error?.message || error.message}`);
    return { ...result, text: current };
  }
};

module.exports = { needsNaturalRewrite, cleanBody };
