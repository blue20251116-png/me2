const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 규칙 v12]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 실제 Threads 사람이 피드에 바로 쓴 글처럼 자연스럽고 날것으로 쓴다
- 상품명이나 장점부터 설명하지 말고 입력 근거 안의 구체적인 상황 사건 장면 발견부터 시작한다
- 시작 방식은 반응형 상황형 목격형 지인계기형 문제형 실패형 결과선공개형 우연발견형 의외성형 등에서 소재에 맞게 자유롭게 고른다
- 반응형 시작(소재를 보고 실제로 튀어나오는 감탄이나 반응)도 정상적인 선택지이며 금지하지 않는다 다만 특정 감탄문을 고정 템플릿처럼 반복해서 재사용하지 않는다 입력 소재에서 실제로 떠오르는 반응을 매번 새롭게 구성한다
- 최근 글처럼 보이는 상투적인 첫 문장을 습관적으로 반복하지 않는다
- 원문에 이미 자연스럽고 구체적인 첫 상황이 있으면 그 사실과 흐름을 우선 살린다
- 한 줄 길이를 숫자로 맞추려고 문장을 억지로 자르지 않는다
- 짧은 문장과 조금 긴 문장을 자연스럽게 섞고 의미가 이어지는 1~2문장은 같은 문단으로 둔다
- 글마다 줄 수와 문단 수를 똑같이 맞추지 않는다
- 기본 흐름은 상황/사건 → 궁금증이나 발견 → 확인 가능한 장면 또는 기능 하나 → 짧은 반응이며 소재에 따라 순서를 바꿔도 된다
- 마무리를 매번 감탄이나 구매 의향으로 끝낼 필요 없다
- 질문 궁금증 관찰 담백한 정보 전달로 끝낼 수도 있다
- 특정 질문 문구도 반복 템플릿처럼 사용하지 않는다
- 자연스러우면 별도 마무리 없이 끝내도 된다
- 광고 장점은 최대 하나만 직접 말한다
- 활용도 높다 실용적이다 강력 추천 꼭 써봐 삶의 질 같은 광고 상투어 금지
- 원문에 없는 남편 친구 엄마 구매 사용 섭취 경험을 절대 만들지 않는다
- 원문에 없는 구매 소유 사용 섭취 경험을 절대 만들지 않는다
- 원문에 없는 남편 아내 엄마 친구 아이 직장동료 등 관계를 새로 만들지 않는다
- 관계 주체가 원문에 명시되지 않으면 임의로 등장시키지 않는다
- 실제 사용 근거가 없으면 봤는데 / 보니까 / 영상에서 보는데처럼 관찰 범위로만 쓴다
- 사실성 없는 서사를 만들 바에는 문장을 짧게 쓰는 것이 우선이다
- 건강식품은 효과 체험을 만들지 않는다
- ~더라 / ~더라고 종결은 사용하지 않는다
- ~냐 금지
- 음슴체 금지
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ;; ? ㄷㄷ 같은 Threads 표현은 소재에 맞을 때 자연스럽게 0~2회 사용한다

[호흡 예시 - 구조만 참고하고 사실은 입력 근거에 맞게 변주]
이거 완전 속을 뻔;;
잠깐 뜨거운 데 뒀다가 다시 보니까
색이 완전 다르게 변해있어

이거 아는 사람 있어?
`;

function isThreadsWritingPrompt(content) {
  const s = String(content || '');
  return /한국 Threads/.test(s) && /(쇼핑\/레시피 글 편집자|본문 말투 교정기|실제 사람이 올린 것 같은 글|최종 편집기)/.test(s);
}

axios.post = async function patchedReactionPost(url, data, config) {
  try {
    if (url === 'https://api.openai.com/v1/chat/completions' && Array.isArray(data?.messages)) {
      const messages = data.messages.map(m => ({ ...m }));
      const systemIndex = messages.findIndex(m => m.role === 'system');
      if (systemIndex >= 0 && isThreadsWritingPrompt(messages[systemIndex].content)) {
        messages[systemIndex].content = String(messages[systemIndex].content || '') + reactionGuide;
        data = { ...data, messages };
        console.log('[AutopilotV3][REACTION TONE] v14 exact anchor 제거 · 사실성 규칙 명시화 injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v14 exact anchor 제거 · 사실성 규칙 명시화');
