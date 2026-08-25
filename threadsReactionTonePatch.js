const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 규칙 v17 - 비정형 사건 + 모바일 호흡]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 제품을 설명하기보다 원문에 있는 구체적인 장면이나 반응 하나를 잡는다
- 사건에는 정해진 순서가 없다
- 발견 → 의심 → 행동 → 확인 → 반응 순서를 기본 공식으로 쓰지 않는다
- '이거 → 처음엔/뭐지 → 근데/보니까 → 생각보다' 구조를 반복하지 않는다
- 대상부터 평가하는 '이거 아이디어 괜찮다' '이 조합 신기하다' 같은 시작을 습관적으로 쓰지 않는다
- 어떤 글은 상황 중간에서 시작하고 어떤 글은 결과부터 어떤 글은 행동부터 어떤 글은 짧은 반응만 쓰고 끝내도 된다
- 직접 경험 근거가 없으면 구매 사용 경험을 지어내지 않는다
- 장점을 직접 나열하기보다 원문에 있는 행동 장면 변화 반응을 우선한다
- 모든 글에 의심 놀람 반전을 억지로 만들지 않는다
- 마지막 감정 회수나 결론이 없어도 된다
- 같은 후킹 같은 사건 같은 마무리를 반복하지 않는다

[Threads 모바일 호흡]
- 한 행은 대체로 짧게 쓰되 숫자로 길이를 맞추지 않는다
- 조사나 어절 중간에서 강제로 자르지 않는다
- 서로 이어지는 문장은 붙여도 된다
- 장면이나 감정이 바뀔 때만 빈 줄을 사용할 수 있다
- 강한 전환에서는 빈 줄 2개도 가능하지만 매 글 같은 위치에 넣지 않는다
- 글마다 줄 수 문단 수 행 길이를 똑같이 맞추지 않는다
- 단독 반응행은 정말 필요한 경우에만 쓴다

[반응 표현]
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ㄷㄷ ;; 같은 표현은 문맥상 감정이 생기는 위치에서만 선택적으로 사용한다
- 하나도 없어도 정상이다
- 첫 문장 끝에 ㅋㅋ를 기본 장식처럼 붙이지 않는다
- 한 글에 여러 인터넷 표현을 몰아넣지 않는다
- 음슴체 금지
- ~함 ~임 ~됨 ~없음 ~있음 같은 종결 금지
- 문장 종결을 억지로 잘라 '알겠ㅋㅋ' '괜찮겠ㅋㅋ'처럼 만들지 않는다

[사실성/안전]
- 원문에 직접 구매 사용 섭취 경험이 있으면 그 체감은 살려도 된다
- 원문에 직접 경험이 없으면 내가 샀다 써봤다 먹어봤다처럼 사실인 척 만들지 않는다
- 엄마 친구 남편 등 구체적인 제3자 추천 구매 경위는 입력 근거 없이 만들지 않는다
- 건강식품은 효과 체험을 만들지 않는다
- 확인되지 않은 의학적 효능 안전성 할인율 가격 절감 성과는 단정하지 않는다
- ~냐 종결 금지
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지

[최종 목표]
- 잘 쓴 광고가 아니라 실제 사람이 툭 올린 서로 다른 글처럼 보여야 한다
- 자연스러움보다 더 중요한 건 반복되는 생성 공식이 보이지 않는 것이다
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
        console.log('[AutopilotV3][REACTION TONE] v17 non-template diversity injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v17 non-template diversity + no eumseum');
