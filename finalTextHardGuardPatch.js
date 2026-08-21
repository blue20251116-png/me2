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

function hasAwkwardLineBreak(text) {
  const lines = String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  const danglingEnd = /(은|는|이|가|을|를|도|만|에|의|와|과|로|으로|부터|까지|해서|하고|는데|니까|면|지만|다가|거나|처럼|보다|정도|진짜|완전)$/;
  const awkwardStart = /^(보이|달라지|되어|돼|해서|하고|그러니까|그래서|근데|그런데|때문에|같아서|같으니까)/;

  for (let i = 0; i < lines.length - 1; i++) {
    if (danglingEnd.test(lines[i]) || awkwardStart.test(lines[i + 1])) return true;
  }
  return false;
}

function badStyleReasons(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const reasons = [];

  if (/(더라|하더라|했더라|더라고|하더라고|했더라고)/i.test(t)) reasons.push('더라체');
  if (/(?:^|\s)[가-힣A-Za-z0-9]+(?:함|됨|임|했음|있음|없음|좋음|편함|남다름|끝남|해결됨)(?=\s|$|[!?~ㅋㅎ])/m.test(t)) reasons.push('음슴체');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('냐체');
  if (/[,.]/.test(t.replace(/\d+\.\d+/g, ''))) reasons.push('마침표/쉼표');
  if (/필수인듯|좋은듯|괜찮은듯|되는듯|같은듯/i.test(t)) reasons.push('듯체');
  if (/추천|장만|괜찮을 거야|필수템|꿀템/i.test(t)) reasons.push('구매권유');
  if (/^(?:ㅋ{1,8}|ㅎ{1,8}|ㄷㄷ)[!?]*$/m.test(t)) reasons.push('단독반응');
  if (hasAwkwardLineBreak(t)) reasons.push('어색한줄바꿈');
  if (lines.some(line => line.length > 58)) reasons.push('긴줄');
  if (/(효과가|효과는|사용하면|사용해주면|관리해주니까|기능이|장점은|특징은).*(효과|기능|장점|특징|좋아|편해)/i.test(t)) reasons.push('설명형');

  return [...new Set(reasons)];
}

function fallbackRewrite(text) {
  let s = hardSanitize(text);
  const pairs = [
    [/불편함/g, '불편해'], [/해결됨/g, '해결돼'], [/편함/g, '편해'], [/좋음/g, '좋아'],
    [/남다름/g, '확실히 달라'], [/있음/g, '있어'], [/없음/g, '없어'], [/끝남/g, '끝나'],
    [/필수인듯/g, '꼭 필요할 것 같아'], [/좋은듯/g, '좋은 것 같아'], [/괜찮은듯/g, '괜찮은 것 같아']
  ];
  for (const [re, to] of pairs) s = s.replace(re, to);

  // 더라체는 기계적으로 어미 일부만 바꾸면 문장이 깨질 수 있으므로
  // 최소한 자주 나오는 형태만 자연스러운 종결로 바꾼다
  s = s
    .replace(/달라지더라/g, '확실히 달라')
    .replace(/좋더라/g, '좋아')
    .replace(/편하더라/g, '편해')
    .replace(/놀랐더라/g, '놀랐어')
    .replace(/했더라/g, '했어')
    .replace(/하더라/g, '해')
    .replace(/했더라고/g, '했어')
    .replace(/하더라고/g, '해')
    .replace(/더라고/g, '')
    .replace(/더라/g, '');

  // ~냐 반말 질문형은 최종 발행에서 금지한다
  // AI 재작성 실패 시에도 자주 나오는 형태를 최소한 자연스럽게 정리한다
  s = s
    .replace(/뭐냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '뭐지')
    .replace(/거냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '건가')
    .replace(/없냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '없나')
    .replace(/맞냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '맞나')
    .replace(/했냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '했나')
    .replace(/봤냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '봤나')
    .replace(/냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '나');

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
      temperature: 0.55,
      max_tokens: 550,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 본문 최종 말투 검수기다
내용과 사실은 유지하되 사람이 직접 올린 짧은 반응글처럼 고친다

절대 규칙
- 자연스러운 반말
- ~냐 형태의 반말 질문 어미 전부 금지 예: 없냐 맞냐 해봤냐 먹어봤냐 뭐냐
- 질문이 필요하면 ~나 ~지 ~인가 같은 더 부드러운 표현을 쓰거나 평서문으로 바꾼다
- 3~5줄 권장 필요하면 2~6줄
- 한 줄에는 하나의 생각만 쓴다
- 한 문장을 중간에서 어색하게 쪼개지 않는다
- 조사나 연결어 앞에서 줄바꿈하지 않는다
- 한 줄을 너무 길게 쓰지 않는다
- 설명보다 반응이 앞서야 한다
- 영상 속 행동 순서나 제품 사용법을 다시 설명하지 않는다
- 기능 장점 효과를 여러 개 나열하지 않는다
- 제품명 직접 언급은 꼭 필요할 때만 한다
- 음슴체 금지
- 더라 하더라 했더라 더라고 하더라고 했더라고 전부 금지
- 기계적인 듯체 금지
- 마침표와 쉼표 금지
- ㅋㅋ는 필요할 때 최대 1회만 쓰고 단독 줄 금지
- 추천 구매권유 꿀템 필수템 장만 같은 광고 문구 금지
- 확인되지 않은 구매 사용 경험을 새로 만들지 않는다
- 설명을 늘리지 않는다
- 마지막에 친절한 총평이나 추천 결론을 붙이지 않는다
JSON만 출력: {"text":""}`,
        },
        { role: 'user', content: `모드:${mode}\n위반:${reasons.join(',')}\n고칠 본문:\n${current}` },
      ],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 30000,
    });

    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const fixed = hardSanitize(parsed.text || '');
    const remaining = badStyleReasons(fixed);

    if (fixed && !remaining.length) {
      console.log(`[AutopilotV3][TEXT HARD GUARD] 재작성 통과 reason=${reasons.join(',')}`);
      return fixed;
    }

    console.warn(`[AutopilotV3][TEXT HARD GUARD] AI 재작성 잔여 규칙 위반 → 규칙 기반 정리 reason=${remaining.join(',')}`);
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

console.log('[Autopilot][TEXT HARD GUARD] 반응형 호흡·더라체·음슴체·냐체·줄바꿈·긴줄·설명형 최종 강제검사 활성화');
