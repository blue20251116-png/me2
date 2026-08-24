const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 규칙 v15]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 실제 Threads 사람이 피드에 바로 쓴 글처럼 자연스럽고 날것으로 쓴다
- 상품명이나 장점부터 설명하지 말고 생활 상황 장면 행동 결과 중 하나에서 바로 시작해도 된다
- 시작 방식은 반응형 상황형 목격형 문제형 실패형 결과선공개형 우연발견형 의외성형 등에서 소재에 맞게 자유롭게 고른다
- 특정 감탄문을 고정 템플릿처럼 재사용하지 않는다
- 와 아니 진짜 대박 미쳤다 같은 말 자체는 금지하지 않지만 매 글의 기본 시작으로 쓰지 않는다
- 원문에 자연스럽고 구체적인 첫 상황이 있으면 그 흐름을 우선 살린다
- 짧은 문장과 조금 긴 문장을 자연스럽게 섞고 의미가 이어지는 문장은 같은 문단으로 둔다
- 글마다 줄 수와 문단 수를 똑같이 맞추지 않는다
- 마무리를 매번 감탄이나 질문으로 끝낼 필요 없다
- 광고 장점은 여러 개 나열하지 말고 생활에서 느껴지는 핵심 한두 개만 자연스럽게 녹인다
- 활용도 높다 실용적이다 강력 추천 꼭 써봐 삶의 질 같은 광고 상투어 금지
- 음슴체는 실제 Threads에서 자연스럽게 쓰이는 문체이므로 허용한다
- ~함 ~임 ~됨 ~없음 ~바뀜 ~사라짐 ~끝임 같은 종결도 문맥에 자연스러우면 그대로 사용해도 된다
- 모든 문장을 음슴체로 맞추지 말고 평서형과 섞어서 리듬을 만든다
- ㅋㅋ ㅠㅠ ;; ;;;; ㄷㄷ 같은 표현은 억지로 넣지 않는다 소재에 맞으면 자유롭게 쓰고 하나도 없어도 정상이다
- 문장 종결을 억지로 잘라 '알겠ㅋㅋ' '괜찮겠ㅋㅋ'처럼 어색하게 만들지 않는다
- 원문에 직접 구매 사용 섭취 경험이 있으면 그 체감은 살려도 된다
- 원문에 직접 경험이 없으면 내가 샀다 써봤다 먹어봤다처럼 사실인 척 만들지 말고 관찰형이나 가정형으로 쓴다
- 엄마 친구 남편 등 구체적인 제3자가 추천해서 샀다 써봤다 같은 추천·구매 경위는 입력 근거 없이 만들지 않는다
- 건강식품은 효과 체험을 만들지 않는다
- 확인되지 않은 의학적 효능 안전성 할인율 가격 절감 성과는 단정하지 않는다
- ~냐 종결은 사용하지 않는다
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지

[목표 결]
- 잘 쓴 문장보다 실제 사람이 툭 올린 문장을 우선한다
- 조금 거칠어도 된다
- 감정기호와 음슴체가 섞여도 된다
- 생활 불편 → 발견 → 만드는 법/사용 장면 → 체감 한마디처럼 자연스럽게 이어갈 수 있다
- 같은 후킹 문장을 반복하지 않는다
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
        console.log('[AutopilotV3][REACTION TONE] v15 raw Threads style · 음슴체 허용 injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v15 raw Threads style · 음슴체 허용');
