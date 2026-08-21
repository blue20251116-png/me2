const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map(x => x.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rejectReasons(text) {
  const t = clean(text);
  const reasons = [];
  const allLines = t.split('\n');
  const lines = allLines.map(x => x.trim()).filter(Boolean);
  const blankLines = allLines.filter(x => !x.trim()).length;

  if (!t) reasons.push('empty');
  if (lines.length < 3 || lines.length > 7) reasons.push('line-count');
  if (lines.some(x => x.length > 30)) reasons.push('long-line');
  if (lines.length >= 4 && blankLines < 1) reasons.push('no-paragraph');

  // 고아 줄: "같아" "ㅋㅋ"처럼 의미가 끊겨 혼자 떨어진 줄
  if (lines.some(x => x.length <= 4)) reasons.push('orphan-line');
  if (lines.some(x => /^(?:같아|같네|같음|ㅋㅋ+|ㅎㅎ+|ㅠ+|ㅜ+|ㄷㄷ+|추천해|적을게|남길게)$/i.test(x))) reasons.push('orphan-fragment');

  // 존댓말/정제된 설명체
  if (/(?:입니다|합니다|됩니다|하세요|해보세요|추천드립니다|수 있습니다)/.test(t)) reasons.push('formal-tone');

  // AI 후기/광고 상투어
  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) reasons.push('ai-review');
  if (/이거\s*없(?:인|으면).*못\s*살|없으면\s*안\s*될|놓치면\s*후회|강추|무조건\s*(?:사|먹|써|추천)|꼭\s*(?:사|먹|써).*봐/i.test(t)) reasons.push('cta-review');
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|포인트인\s*듯|이런\s*거\s*찾던\s*사람|한번\s*(?:써|먹|사용)보면\s*좋을\s*것\s*같/i.test(t)) reasons.push('product-copy');
  if (/세정력\s*미쳤|통증이\s*사라|수술\s*없이.*관리|이게\s*실화야|대박!?[😲😂]?/i.test(t)) reasons.push('template-hype');

  // 근거 없는 주변 사람 반응을 만드는 패턴 강하게 차단
  if (/(?:애들|엄마들|친구|남편|언니|주변\s*사람|다들).{0,45}(?:난리|바로\s*주문|사달|계속\s*해달|맛있다고|추천해줬|물어보)/i.test(t)) reasons.push('social-proof-story');

  // 사용자가 금지한 말끝
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya-ending');
  if (/(?:했|됐|왔|갔|봤|먹었|썼|샀|좋았|괜찮았|편했|있었|없었|겠|있|없|좋|편)음(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('generic-eumseum');

  // 단, 실제 스레드식 축약 "대박임" "딱임"은 허용
  return [...new Set(reasons)];
}

function promptFor(mode) {
  const recipe = mode === 'recipe';
  return `너는 한국 Threads 실제 사용자 말투 전용 최종 편집기다
광고 카피 상품후기 블로그체를 만들면 실패다
문법적으로 예쁘게 쓰는 것보다 폰으로 바로 올린 듯한 짧고 거친 리듬을 우선한다

[핵심 스타일]
- 첫 줄은 설명이 아니라 즉각적인 반응부터 시작한다
- 자연스러우면 ㅁㅊ ㅋㅋ ㅠㅠ ㅜㅠ ;; ?! ㄷㄷ 같은 표현을 허용한다
- '미친'처럼 정제해서 풀어쓰기보다 상황에 맞으면 'ㅁㅊ' 같은 실제 축약을 쓸 수 있다
- 모든 글에 같은 자음이나 후킹을 억지로 넣지 않는다
- 한 글에서 눈에 보이는 핵심 특징은 1개 정도만 잡는다
- 장점 3개 나열 금지
- 친구 엄마 애들 남편 언니 같은 주변인 반응을 새로 만들지 않는다
- 현재 글에 그런 허구 사회적 증거가 있으면 제거한다
- 현재 글에 있는 사실만 사용하고 새로운 효능 경험 구매 사실을 만들지 않는다

[좋은 리듬 예시]
와 ㅁㅊ 이거 추천해준 스친 절받아 ㅠㅠ

토마토 안에 이 크림치즈가 대박임;
도대체 뭐길래 이렇게 맛있냐고 ㅁㅊ
간식으로도 술안주로 딱임 ㅠㅠㅠㅠ

또 다른 예시
이거 왜 이제 알았지ㅋㅋ
새 방석 바꿔줬더니 여기서 안 나와

그냥 쏙 들어가서 자는데
저 다리 나온 거 너무 웃겨ㅋㅋ

예시 문장을 복사하지 말고 짧고 불규칙한 리듬만 따라라

[줄바꿈]
- 실제 내용 줄 3~7개
- 한 줄 최대 30자
- 긴 문장을 중간에서 잘라 줄 길이만 맞추지 않는다
- 처음부터 짧은 문장으로 다시 쓴다
- 1~2줄 뒤 빈 줄 하나 정도를 자연스럽게 둔다
- '같아' 'ㅋㅋ' 같은 1~4글자 조각을 혼자 한 줄로 떨어뜨리지 않는다

[금지]
- 완전 짱이야 육즙 폭발 풍미 완벽한 조화 한층 더 매력적인 메뉴
- 이거 없으면 못 살아 없으면 안 될 것 같아 무조건 추천 강추 꼭 써봐 한번 써보면 좋을 것 같아
- 간편하게 활용도 실용적 효율적 편리하다 장점이다 포인트인 듯 이런 거 찾던 사람들
- 세정력 미쳤어 이게 실화야 같은 AI 후기 템플릿
- 존댓말
- ~냐
- 마침표와 쉼표
- 일반적인 음슴체: 좋음 편함 했음 됐음 있음 없음
- 단 실제 스레드 축약인 '대박임' '딱임' 정도는 자연스러울 때 허용
${recipe ? '- 레시피면 핵심 비밀 재료 이름은 숨기고 필요하면 마지막에 재료나 만드는 법은 댓글에 적어둘게 정도만 사용 가능' : '- 일반 상품은 구매 권유나 억지 댓글 유도 없이 짧게 끝낸다'}

JSON만 출력
{"text":""}`;
}

async function rewriteOnce(apiKey, currentText, mode, attempt) {
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: attempt === 1 ? 0.9 : 0.78,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: promptFor(mode) },
      { role: 'user', content: `[현재 AutopilotV3 생성문]\n${currentText}\n\n이 글에서 사실 정보만 남기고 AI 후기 서사와 광고 문장을 버려라\n특히 주변 사람이 난리 났다 주문했다 추천했다는 식의 서사는 삭제해라\n짧고 거친 실제 Threads 말투로 처음부터 다시 써라` },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });
  const raw = r.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return clean(parsed.text || '');
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) {
    const reasons = rejectReasons(result.text);
    if (reasons.length) throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] OpenAI key 없음 reasons=${reasons.join(',')}`);
    return result;
  }

  let current = clean(result.text);
  let reasons = rejectReasons(current);

  // AutopilotV3 내부 검수가 통과했어도 항상 한 번 사람말투로 최종 재작성
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rewritten = await rewriteOnce(apiKey, current, result.mode, attempt);
      const nextReasons = rejectReasons(rewritten);
      console.log(`[AutopilotV3][HUMAN FINAL] attempt=${attempt} reasons=${nextReasons.join(',') || 'PASS'} preview="${rewritten.slice(0,100).replace(/\n/g,' / ')}"`);
      if (rewritten && nextReasons.length === 0) {
        return { ...result, text: rewritten };
      }
      if (rewritten) current = rewritten;
      reasons = nextReasons;
    } catch (e) {
      console.warn(`[AutopilotV3][HUMAN FINAL] attempt=${attempt} rewrite error=${e.response?.data?.error?.message || e.message}`);
    }
  }

  // 기존 AI 생성문으로 fallback하지 않는다. 품질검수 실패 글은 발행 차단.
  throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 최종 말투 검수 실패 reasons=${(reasons || []).join(',') || 'unknown'}`);
};

console.log('[AutopilotV3][HUMAN FINAL] v1 hard-guard loaded');
