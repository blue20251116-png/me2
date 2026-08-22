const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 추가 규칙]
- 설명문이나 제품 기능 요약처럼 쓰면 실패다
- 영상/사진에서 제일 눈에 띄는 장면에 대한 반응을 먼저 보여줘라
- 그 다음 핵심 사실 한두 개만 짧게 붙여라
- 마지막을 '편하다' '좋다' 같은 제품 총평으로 정리하지 마라
- 신기한 상품에는 상황에 맞으면 ㅁㅊㅋㅋ ㄷㄷ 뭐야 이거;; 이건 좀 탐난다 같은 반응을 쓸 수 있다
- 음식이나 레시피에는 상황에 맞으면 존맛탱 개맛있겠다 이 조합 뭐야ㅋㅋ 같은 반응을 쓸 수 있다
- 편의용품에는 상황에 맞으면 개편하겠다 이걸 왜 이제 알았지ㅋㅋ 같은 반응을 쓸 수 있다
- 유행어는 글마다 강제로 넣지 말고 0~2개만 자연스럽게 선택해라
- 같은 시작 같은 감탄사 같은 ㅋㅋ 패턴을 연속 반복하지 마라
- '버튼만 누르면 알아서 돌아가네 스푼 찾을 일도 없고 설거지도 편하다' 같은 기능 나열형 설명문은 실패다
- '아니 컵이 지가 알아서 섞어주네ㅋㅋ / 버튼 한번 누르니까 바로 돌아감 / 이런 게 왜 있는 거야 ㅁㅊㅋㅋ'처럼 반응→핵심장면→짧은반응의 호흡을 참고하되 문장을 그대로 복사하지 마라
- 입력에 없는 구매 사용 섭취 가족 친구 경험은 절대 만들지 마라
- ~냐 금지
- 일반적인 음슴체 좋음 편함 했음 됐음 있음 없음 금지
- 문장 끝 마침표 쉼표 금지
`;

axios.post = async function patchedReactionPost(url, data, config) {
  try {
    if (url === 'https://api.openai.com/v1/chat/completions' && Array.isArray(data?.messages)) {
      const messages = data.messages.map(m => ({ ...m }));
      const systemIndex = messages.findIndex(m => m.role === 'system');
      if (systemIndex >= 0 && /한국 Threads에서 실제 사람이 올린 것 같은 글을 만드는 최종 편집기/.test(String(messages[systemIndex].content || ''))) {
        messages[systemIndex].content = String(messages[systemIndex].content || '') + reactionGuide;
        data = { ...data, messages };
        console.log('[AutopilotV3][REACTION TONE] v6 guide injected into HUMAN FINAL');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v6 natural slang injector loaded');
