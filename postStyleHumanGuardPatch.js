'use strict';

const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const system = getSystemApiSettings();
  return system.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

const EMPTY_AI_PHRASES = /(?:없는\s*삶은?\s*상상도\s*못|없이는?\s*못\s*살|중독될\s*수밖에|그냥\s*.+(?:이|가)\s*아닌\s*듯|이렇게\s*매력적이었나|완전\s*기대(?:됨|돼)|대체\s*어떤\s*건지\s*궁금|다\s*알겠지|정답이지|행복해\s*보이다니)/i;
const INVENTED_RELATION = /(?:친구|남편|아내|언니|오빠|동생|엄마|아빠|지인|주변\s*사람).{0,40}(?:행복해|좋아해|먹고|쓰고|샀|추천|말했|난리|부풀|반응)/i;
const REACTION_TOKEN = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|ㅠㅠ+|ㅜㅜ+|😆|😂|🤣|🔥|헐|존맛탱|개맛|미쳤)/gi;

function inspect(text) {
  const t = clean(text);
  const reasons = [];
  if (EMPTY_AI_PHRASES.test(t)) reasons.push('empty-ai-sentiment');
  if (INVENTED_RELATION.test(t)) reasons.push('invented-relation');
  const reactions = t.match(REACTION_TOKEN) || [];
  if (reactions.length > 2) reasons.push('reaction-overuse');
  if (/ㅎㅎ/.test(t) && /ㅁㅊ/.test(t)) reasons.push('mixed-forced-reaction');
  if (/ㅋㅋ/.test(t) && /ㅎㅎ/.test(t) && /[😆😂🤣]/.test(t)) reasons.push('mixed-forced-reaction');
  return [...new Set(reasons)];
}

function prompt(mode, reasons) {
  return `너는 한국 Threads 최종 검수 편집기다
이 단계는 Style Profile 적용 뒤의 마지막 안전장치다

[검수 실패]
${reasons.join(', ')}

[목표]
- 사진이나 원문에서 실제로 확인되는 핵심 포인트 하나에 짧게 반응한다
- 사람이 사진을 보고 바로 툭 적은 것처럼 쓴다
- 설명을 늘리기 위해 의미 없는 감상을 추가하지 않는다

[절대 금지]
- 입력에 없는 친구 남편 가족 지인 관계를 만들지 않는다
- 입력에 없는 사용 구매 시식 경험을 만들지 않는다
- 없는 삶은 상상 못 한다 중독될 수밖에 없다 그냥 ~이 아닌 듯 정답이지 같은 빈 감상문을 쓰지 않는다
- ㅋㅋ ㅎㅎ ㅁㅊ 이모지를 사람 말투처럼 보이게 하려고 억지로 섞지 않는다
- 반응표현은 필요할 때 최대 1~2개만 쓴다
- 존댓말 ~냐 음슴체 ~더라 계열 금지
- 마침표와 쉼표 금지
- 광고 카피와 구매 권유 금지
- 원래 상품명 재료명 사실관계는 바꾸지 않는다
- 확실하지 않은 사실은 새로 만들지 않는다

[형식]
- 보통 3~5줄
- 짧고 의미 있는 문장만 남긴다
- 원문이 이미 자연스러우면 최소한만 수정한다
- mode=${mode || 'product'}

JSON만 출력
{"text":""}`;
}

async function rewrite(accountId, text, mode, reasons) {
  const key = getOpenAIKey(accountId);
  if (!key) return text;
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.55,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt(mode, reasons) },
      { role: 'user', content: `[Style Profile 적용 후 본문]\n${text}\n\n걸린 문제만 제거하고 사실은 추가하지 마라` }
    ]
  }, {
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    timeout: 30000
  });
  const raw = response.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return clean(parsed.text || text);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  if (String(process.env.POST_STYLE_HUMAN_GUARD_ENABLED || '1') === '0') return result;

  const current = clean(result.text);
  const reasons = inspect(current);
  if (!reasons.length) {
    console.log(`[AutopilotV3][POST STYLE GUARD] PASS preview="${current.slice(0, 160).replace(/\n/g, ' / ')}"`);
    return { ...result, text: current };
  }

  try {
    const fixed = await rewrite(accountId, current, result.mode, reasons);
    const remaining = inspect(fixed);
    console.log(`[AutopilotV3][POST STYLE GUARD] REWRITE reasons=${reasons.join(',')} remaining=${remaining.join(',') || 'PASS'} preview="${fixed.slice(0, 160).replace(/\n/g, ' / ')}"`);
    if (!remaining.length) return { ...result, text: fixed };

    // 재작성 결과가 여전히 부자연스러우면 새 사실을 더 만들지 않고 기존 결과를 유지한다.
    // 기존 hard guard와 sanity guard가 이미 앞단에서 사실/형식을 검증한다.
    return { ...result, text: current };
  } catch (error) {
    console.warn(`[AutopilotV3][POST STYLE GUARD] rewrite skipped error=${error.response?.data?.error?.message || error.message}`);
    return { ...result, text: current };
  }
};

module.exports = { inspect, clean };
