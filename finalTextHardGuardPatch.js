const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function getOpenAIKey(accountId) {
  const a = getAccount(accountId), s = getSystemApiSettings();
  return s.openai_api_key || process.env.OPENAI_API_KEY || a?.openai_api_key || null;
}

function hardSanitize(text) {
  let s = String(text || '').replace(/\r/g, '');
  s = s.replace(/,/g, '');
  // 숫자 소수점(1.5 등)을 제외한 일반 마침표 전부 제거
  s = s.replace(/(^|[^0-9])\.(?![0-9])/g, '$1');
  s = s.replace(/\.\.+/g, '');
  let lines = s.split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ|ㅠ{1,5}|ㅜ{1,5})[!?]*$/.test(line)) {
      if (out.length) out[out.length - 1] += line;
      continue;
    }
    out.push(line);
  }
  return out.slice(0, 6).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function badStyleReasons(text) {
  const t = String(text || '');
  const reasons = [];
  if (/(?:더라|하더라|했더라|더라고|하더라고|했더라고)(?:\b|[!?~ㅋㅎ])/i.test(t)) reasons.push('더라체');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|남다름|끝남|해결됨)(?:\b|[!?~ㅋㅎ])/m.test(t)) reasons.push('음슴체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/필수인듯|좋은듯|괜찮은듯|되는듯|같은듯/i.test(t)) reasons.push('듯체');
  if (/추천|장만|괜찮을 거야|필수템|꿀템/i.test(t)) reasons.push('구매권유');
  if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ)[!?]*$/m.test(t)) reasons.push('단독반응');
  return reasons;
}

function fallbackRewrite(text) {
  let s = hardSanitize(text);
  const pairs = [
    [/불편함/g, '불편해'], [/해결됨/g, '해결돼'], [/편함/g, '편해'], [/좋음/g, '좋아'],
    [/남다름/g, '확실히 달라'], [/있음/g, '있어'], [/없음/g, '없어'], [/끝남/g, '끝나'],
    [/필수인듯/g, '꼭 필요할 것 같아'], [/좋은듯/g, '좋은 것 같아'], [/괜찮은듯/g, '괜찮은 것 같아'],
    [/했더라고/g, '했어'], [/하더라고/g, '해'], [/더라고/g, '어'], [/했더라/g, '했어'], [/하더라/g, '해'], [/더라/g, '어'],
  ];
  for (const [re, to] of pairs) s = s.replace(re, to);
  return hardSanitize(s);
}

async function rewriteIfNeeded(accountId, text, mode) {
  let current = hardSanitize(text);
  const reasons = badStyleReasons(current);
  if (!reasons.length) return current;

  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) return fallbackRewrite(current);

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.45,
      max_tokens: 650,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 본문 최종 말투 검수기다\n내용과 사실은 유지하고 말투만 자연스럽게 고친다\n절대 규칙\n- 자연스러운 반말\n- 음슴체 금지: ~함 ~됨 ~임 ~했음 ~좋음 ~편함 같은 종결 금지\n- ~더라 ~하더라 ~더라고 ~하더라고 금지\n- 필수인듯 같은 기계적인 ~듯 종결 금지\n- 마침표와 쉼표 금지\n- ㅋㅋ는 필요할 때 문장 끝에 최대 1번만 쓰고 단독 줄 금지\n- 추천 구매권유 꿀템 필수템 장만 같은 광고 문구 금지\n- 확인되지 않은 구매 사용 경험을 새로 만들지 않는다\n- 설명을 늘리지 않는다\n- 2~6줄 안에서 말하듯 쓴다\nJSON만 출력: {"text":""}`,
        },
        { role: 'user', content: `모드:${mode}\n고칠 본문:\n${current}` },
      ],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 30000,
    });
    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const fixed = hardSanitize(parsed.text || '');
    if (fixed && !badStyleReasons(fixed).length) {
      console.log(`[AutopilotV3][TEXT HARD GUARD] 재작성 통과 reason=${reasons.join(',')}`);
      return fixed;
    }
    console.warn(`[AutopilotV3][TEXT HARD GUARD] AI 재작성 잔여 규칙 위반 → 규칙 기반 정리 reason=${badStyleReasons(fixed).join(',')}`);
    return fallbackRewrite(fixed || current);
  } catch (e) {
    console.warn(`[AutopilotV3][TEXT HARD GUARD] AI 재작성 실패 → 규칙 기반 정리 reason="${e.response?.data?.error?.message || e.message}"`);
    return fallbackRewrite(current);
  }
}

engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  result.text = await rewriteIfNeeded(accountId, result.text, result.mode);
  result.text = hardSanitize(result.text);
  const remaining = badStyleReasons(result.text);
  if (remaining.length) {
    console.warn(`[AutopilotV3][TEXT HARD GUARD] 최종 잔여=${remaining.join(',')} text="${result.text.replace(/\n/g, ' / ').slice(0,180)}"`);
  }
  return result;
};

console.log('[Autopilot][TEXT HARD GUARD] 더라체·음슴체·마침표·쉼표·구매권유 최종 강제검사 활성화');
