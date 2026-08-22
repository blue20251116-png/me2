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

function mergeAwkwardLineBreaks(text) {
  const raw = clean(text);
  if (!raw) return raw;
  const source = raw.split('\n');
  const out = [];
  const danglingEnd = /(은|는|이|가|을|를|도|만|에|의|와|과|로|으로|부터|까지|해서|하고|는데|니까|면|지만|다가|거나|처럼|보다|정도|기분도|생각도|마음도)$/;
  const fragmentStart = /^(같아|같네|같아서|같으니까|좋고|좋아|있어|없어|했어|돼|되고|해서|하고|보여|보이고|느껴|느낌이|때문에|정도라|정도고)/;
  for (let i = 0; i < source.length; i++) {
    const line = source[i].trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let prevIndex = out.length - 1;
    while (prevIndex >= 0 && out[prevIndex] === '') prevIndex--;
    const prev = prevIndex >= 0 ? out[prevIndex] : '';
    if (prev && (danglingEnd.test(prev) || fragmentStart.test(line))) {
      out[prevIndex] = `${prev} ${line}`.trim();
      out.splice(prevIndex + 1);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function ensureParagraphs(text) {
  const t = mergeAwkwardLineBreaks(text);
  if (!t || /\n\s*\n/.test(t)) return t;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 4) return t;
  const groups = [];
  for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join('\n'));
  return groups.join('\n\n');
}

function rejectReasons(text) {
  const t = mergeAwkwardLineBreaks(text);
  const reasons = [];
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (!t) reasons.push('empty');
  if (lines.length < 3 || lines.length > 10) reasons.push('line-count');
  if (lines.some(x => x.length > 42)) reasons.push('long-line');
  if (lines.some(x => /^(?:같아|같네|같음|ㅋㅋ+|ㅎㅎ+|ㅠ+|ㅜ+|ㄷㄷ+|추천해|적을게|남길게)$/i.test(x))) reasons.push('orphan-fragment');
  if (/(?:입니다|합니다|됩니다|하세요|해보세요|추천드립니다|수 있습니다)/.test(t)) reasons.push('formal-tone');
  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) reasons.push('ai-review');
  if (/이거\s*없(?:인|으면).*못\s*살|없으면\s*안\s*될|놓치면\s*후회|강추|무조건\s*(?:사|먹|써|추천)|꼭\s*(?:사|먹|써).*봐/i.test(t)) reasons.push('cta-review');
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|포인트인\s*듯|이런\s*거\s*찾던\s*사람|한번\s*(?:써|먹|사용)보면\s*좋을\s*것\s*같/i.test(t)) reasons.push('product-copy');
  if (/세정력\s*미쳤|통증이\s*사라|수술\s*없이.*관리|이게\s*실화야/i.test(t)) reasons.push('template-hype');
  if (/(?:애들|엄마들|친구|남편|언니|주변\s*사람|다들).{0,45}(?:난리|바로\s*주문|사달|계속\s*해달|맛있다고|추천해줬|물어보)/i.test(t)) reasons.push('social-proof-story');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya-ending');
  if (/(?:했|됐|왔|갔|봤|먹었|썼|샀|좋았|괜찮았|편했|있었|없었|겠|있|없|좋|편)음(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('generic-eumseum');
  return [...new Set(reasons)];
}

function promptFor(mode) {
  const recipe = mode === 'recipe';
  return `너는 한국 Threads에서 실제 사람이 올린 것 같은 글을 만드는 최종 편집기다
광고 카피 블로그 후기 상품 설명문처럼 쓰면 실패다
중요한 것은 특정 유행어 복사가 아니라 소재에 맞는 글 구조와 사람다운 호흡이다

[가장 중요한 원칙]
- 먼저 현재 소재의 성격을 판단하고 아래 구조 중 가장 자연스러운 하나를 골라라
- 매번 같은 첫 문장 같은 후킹 같은 결론을 반복하지 마라
- 예시 문장을 복사하지 마라
- 현재 입력에 있는 사실만 사용하라
- 직접 해봤다 샀다 먹었다 며칠 썼다 친구가 말했다 남편이 말했다 같은 경험을 입력에 없으면 만들지 마라
- 장점 목록을 만들지 말고 핵심 한두 개만 잡아라

[사용 가능한 글 구조]
1 따라해봄형: 어디서 본 방법이나 아이디어 → 해본 내용 → 예상 밖 결과
2 발견형: 몰랐던 포인트 발견 → 기존 생각이나 방식 → 새로 알게 된 핵심
3 결과선공개형: 눈에 띄는 결과 → 무엇을 했는지 → 짧은 반응
4 문제해결형: 불편하거나 이상했던 상황 → 해결 방식 → 달라진 점
5 의외성형: 평범해 보였던 물건이나 방법 → 실제 핵심 기능 → 의외의 반응
6 비교형: 기존 방식 → 다른 방식 → 차이 또는 선택
7 레시피발견형: 맛이나 조리 포인트 발견 → 기존 조리 방식 → 핵심 변화 → 댓글 연결
8 짧은반응형: 설명이 거의 필요 없는 강한 사진/영상이면 3~4줄로 짧게

[실제 Threads 리듬]
- ㅋㅋ ㅎㅎ ;; ㄷㄷ ㅠㅠ .. ?! 같은 표현은 상황에 맞을 때만 사용
- 모든 글에 ㅋㅋ나 ㅁㅊ를 넣지 마라
- 아니 와 이거 같은 시작도 반복 사용하지 마라
- 문법을 지나치게 정돈하지 말되 뜻은 바로 이해돼야 한다
- 설명보다 발견 반응 비교 결과가 먼저 보이게 쓴다
- 한 문장을 억지로 잘라 여러 줄로 만들지 않는다
- 짧은 글이 맞는 소재는 짧게 긴 맥락이 필요한 소재는 조금 길게 쓴다

[길이와 줄바꿈]
- 내용 줄 3~10개
- 보통 4~7줄이지만 레시피나 썰은 8~10줄까지 허용
- 한 줄은 가능하면 15~35자 안쪽
- 42자를 넘기지 않는다
- 의미가 끝난 곳에서만 줄바꿈한다
- 1~3줄 단위로 빈 줄을 자연스럽게 넣을 수 있다
- 조사 연결어 같은 조각 뒤에서 자르지 않는다
- ㅋㅋ ㅠㅠ 같아 같은 조각만 한 줄에 두지 않는다

[금지]
- 완전 짱이야 육즙 폭발 풍미 완벽한 조화 한층 더 매력적인 메뉴
- 이거 없으면 못 살아 놓치면 후회 강추 무조건 추천 꼭 써봐
- 간편하게 활용도 실용적 효율적 편리하다 장점이다 포인트인 듯
- 세정력 미쳤어 이게 실화야 같은 정형화된 AI 후기
- 허구의 주변인 반응과 허구의 사용 경험
- 존댓말
- ~냐
- 문장 끝 마침표와 쉼표
- 일반적인 음슴체 좋음 편함 했음 됐음 있음 없음
${recipe ? '- 레시피는 원문 핵심 재료와 조리 사실을 보존하고 비밀 재료를 임의로 만들지 마라\n- 비밀 재료를 숨겨야 하는 입력이면 본문에서 이름을 밝히지 말고 재료나 만드는 법은 댓글로 자연스럽게 연결할 수 있다' : '- 일반 상품은 구매 권유나 억지 댓글 유도 없이 자연스럽게 끝낸다'}

JSON만 출력
{"text":""}`;
}

async function rewriteOnce(apiKey, currentText, mode, attempt) {
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: attempt === 1 ? 0.92 : 0.8,
    max_tokens: 1100,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: promptFor(mode) },
      { role: 'user', content: `[현재 AutopilotV3 생성문]\n${currentText}\n\n현재 글의 사실은 유지하되 문장 자체를 고치는 데 매달리지 말고 소재에 가장 맞는 글 구조를 먼저 선택해서 처음부터 다시 작성해라\n짧게 쓰는 것이 항상 정답은 아니다\n실제 Threads 피드에서 사람이 쓴 것처럼 발견 과정 결과 비교 중 필요한 흐름을 살려라\nAI식 총평 광고 문장 허구 경험 반복 후킹은 제거해라` },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });
  const raw = r.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return ensureParagraphs(parsed.text || '');
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) {
    const formatted = ensureParagraphs(result.text);
    const reasons = rejectReasons(formatted);
    if (reasons.length) throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] OpenAI key 없음 reasons=${reasons.join(',')}`);
    return { ...result, text: formatted };
  }
  let current = ensureParagraphs(result.text);
  let reasons = rejectReasons(current);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rewritten = await rewriteOnce(apiKey, current, result.mode, attempt);
      const fixed = ensureParagraphs(rewritten);
      const nextReasons = rejectReasons(fixed);
      console.log(`[AutopilotV3][HUMAN FINAL] v5 attempt=${attempt} reasons=${nextReasons.join(',') || 'PASS'} preview="${fixed.slice(0,140).replace(/\n/g,' / ')}"`);
      if (fixed && nextReasons.length === 0) return { ...result, text: fixed };
      if (fixed) current = fixed;
      reasons = nextReasons;
    } catch (e) {
      console.warn(`[AutopilotV3][HUMAN FINAL] v5 attempt=${attempt} rewrite error=${e.response?.data?.error?.message || e.message}`);
    }
  }
  throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 최종 말투 검수 실패 reasons=${(reasons || []).join(',') || 'unknown'}`);
};

console.log('[AutopilotV3][HUMAN FINAL] v5 benchmark-structure-selector loaded');
