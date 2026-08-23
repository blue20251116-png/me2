const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 규칙 v11]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 실제 Threads 사람이 피드에 바로 쓴 글처럼 짧고 날것으로 쓴다
- 상품명부터 설명하지 말고 반응이나 생활 상황부터 던진다
- 허용 시작 예: 와 이거 대박이야ㅋㅋ / 이거 진짜 미쳤다ㅋㅋ / 아니 이거 뭐야ㅋㅋ / 와 이런 게 있었네ㅋㅋ
- 같은 시작을 연속해서 반복하지 않는다
- 한 줄에 한 생각만 쓰고 한 줄은 대체로 8~28자
- 4~8개의 짧은 줄을 기본으로 한다
- 1~2줄마다 빈 줄 하나를 넣어 의미 덩어리를 나눈다
- 기본 흐름은 반응/상황 → 실제 불편이나 궁금증 → 발견/제품 장면 → 확인 가능한 결과 또는 기능 하나 → 짧은 반응
- 광고 장점은 최대 하나만 직접 말한다
- 활용도 높다 실용적이다 강력 추천 꼭 써봐 삶의 질 같은 광고 상투어 금지
- 원문에 없는 남편 친구 엄마 구매 사용 섭취 경험을 절대 만들지 않는다
- 실제 사용 근거가 없으면 영상 보다가 봤는데 / 이런 게 있더라 / 보니까 정도로 처리한다
- 건강식품은 효과 체험을 만들지 않는다
- ~냐 금지
- 음슴체 금지
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지
- ㅋㅋ ㅠㅠ ㄷㄷ는 소재에 맞을 때 0~2회 사용한다

[호흡 예시 - 구조만 참고하고 사실은 입력 근거에 맞게 변주]
와 이거 대박이야ㅋㅋ

애기 옷 얼룩 때문에
빨래할 때마다 은근 스트레스였거든

근데 이거 한번 써보고 좀 놀람
생각보다 너무 잘 지워져ㅋㅋ

나 이걸 왜 이제 알았지
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
        console.log('[AutopilotV3][REACTION TONE] v11 actual-writing prompt injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v11 실제 V3 생성/재작성 프롬프트 + Threads 빈줄 호흡 활성화');
