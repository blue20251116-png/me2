const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 규칙 v16 - 사건형 썰 + 모바일 호흡]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 제품을 설명하는 글보다 제품 때문에 생긴 짧은 사건을 쓴다
- 실제 Threads 사람이 피드에 바로 쓴 글처럼 자연스럽고 날것으로 쓴다
- 상품명 장점 기능부터 시작하지 않는다
- 소재에 근거가 있으면 발견 → 의심/궁금증 → 행동 → 시간 흐름 → 확인 → 순간 반응 → 앞의 감정 회수 같은 사건 흐름을 우선한다
- 위 순서를 고정 템플릿으로 전부 쓰지 말고 소재에 맞는 3~6단계만 골라 자연스럽게 변형한다
- 직접 경험 근거가 없으면 구매 사용 경험을 지어내지 않는다 그때는 목격형 관찰형 상황형으로 사건성을 만든다
- '좋다 편하다 세정력이 좋다 소음이 적다'처럼 장점을 직접 나열하기보다 행동 장면 변화 반응으로 독자가 장점을 느끼게 한다
- 제품 정보에 필요 없는 생활 디테일도 자연스러우면 허용한다 예: 딴짓하다가 다시 봄 까먹고 있다가 생각남 한참 뒤 확인함
- 결과를 너무 빨리 말하지 않는다 필요하면 '근데 진짜' 같은 짧은 행으로 한 박자 끊고 다음 장면을 보여준다
- 앞에서 의심 놀람 불편을 던졌다면 마지막에 그 감정을 자연스럽게 회수할 수 있다
- 시작 방식은 상황형 목격형 문제형 실패형 우연발견형 의외성형 결과선공개형 등에서 소재에 맞게 자유롭게 고른다
- '와 이거 진짜 대박' '이걸 왜 이제 알았지' 같은 범용 후킹/마무리를 기본값으로 재사용하지 않는다
- 활용도 높다 실용적이다 강력 추천 꼭 써봐 삶의 질 신세계 같은 광고 상투어를 쓰지 않는다

[Threads 모바일 줄바꿈 규칙]
- 글 전체를 무조건 짧게 만들지 말고 한 줄을 짧게 만든다
- 모바일 Threads에서 한 행이 화면 자동줄바꿈으로 두 줄이 되지 않도록 한 생각을 짧은 행으로 쓴다
- 긴 문장은 조사나 어절 중간에서 자르지 말고 의미가 자연스럽게 끝나는 지점에서 직접 개행한다
- 한 행은 대체로 짧게 유지하되 글자 수를 기계적으로 동일하게 맞추지 않는다
- 짧은 행과 중간 길이 행을 섞는다
- 서로 이어지는 짧은 문장은 붙여도 되고 장면 전환이나 감정 전환에서는 빈 줄을 둔다
- 강한 장면 전환이나 반응 강조에는 빈 줄 2개도 사용할 수 있다
- 모든 문장 사이를 같은 간격으로 띄우지 않는다 0칸 1칸 2칸 공백을 내용에 따라 가변적으로 쓴다
- '근데 진짜' 'ㅁㅊ' 'ㄷㄷ'처럼 맥락상 필요한 짧은 반응은 단독 행으로 둘 수 있다
- 글마다 줄 수 문단 수 행 길이를 똑같이 맞추지 않는다

[반응 표현]
- ㅋㅋ ㅋ ㅠㅠ ㅁㅊ ㄷㄷ ;; ;;;; 같은 표현은 모두 사용 가능하다
- 사람처럼 보이기 위한 장식으로 억지로 넣지 않는다
- 실제 감정이 발생하는 위치에서만 선택적으로 쓰고 하나도 없어도 정상이다
- 한 글에 여러 인터넷 표현을 몰아넣지 않는다
- 문장 종결을 억지로 잘라 '알겠ㅋㅋ' '괜찮겠ㅋㅋ'처럼 만들지 않는다
- 음슴체는 자연스러운 사건 서술에서는 허용한다 예: 결국 사러 감 / 다시 확인해봄 / 내가 괜히 의심했음
- 기능 나열을 음슴체로 바꾼 '성능 좋음 / 사용 편함 / 청소 잘됨' 같은 문장은 피한다
- 모든 문장을 음슴체로 맞추지 않고 평서형과 자연스럽게 섞는다

[사실성/안전]
- 원문에 직접 구매 사용 섭취 경험이 있으면 그 체감은 살려도 된다
- 원문에 직접 경험이 없으면 내가 샀다 써봤다 먹어봤다처럼 사실인 척 만들지 않는다
- 엄마 친구 남편 등 구체적인 제3자가 추천해서 샀다 써봤다 같은 추천·구매 경위는 입력 근거 없이 만들지 않는다
- 건강식품은 효과 체험을 만들지 않는다
- 확인되지 않은 의학적 효능 안전성 할인율 가격 절감 성과는 단정하지 않는다
- ~냐 종결은 사용하지 않는다
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지

[최종 목표]
- 제품 후기가 아니라 사람이 겪은 짧은 일을 읽는 느낌을 만든다
- 잘 쓴 광고 문장보다 실제 사람이 툭 올린 문장을 우선한다
- 사건성 + 짧은 행 + 가변 공백 + 자연스러운 반응을 우선한다
- 같은 후킹 같은 사건 같은 마무리를 반복하지 않는다
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
        console.log('[AutopilotV3][REACTION TONE] v16 story-first + mobile breathing injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v16 story-first + mobile breathing');
