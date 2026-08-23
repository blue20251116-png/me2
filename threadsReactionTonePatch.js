const axios = require('axios');

const originalPost = axios.post.bind(axios);

const reactionGuide = `

[Threads 실제 반응 말투 추가 규칙 v8.1]
- 설명문 광고 카피 블로그 후기 제품 기능 요약처럼 쓰면 실패다
- 사람이 영상을 보고 친구한테 바로 보내면서 쓸 법한 말만 쓴다
- 제품명부터 설명하지 말고 영상 속 장면이나 상황부터 시작한다
- 한 글에서 장점은 최대 1개만 직접 말한다 나머지는 장면으로 보여준다
- 사진이나 영상이 이미 보여주는 내용을 글로 다시 길게 설명하지 않는다
- 마지막을 편리하다 활용도 높다 완전 좋다 추천한다 같은 총평으로 끝내지 않는다

[첫 문장 규칙]
- 첫 문장을 매번 이거 왜 이제 알았지 이거 진짜 미쳤다 아니 이거 뭐야 와 대박으로 시작하지 않는다
- 10개 중 강한 감탄 시작은 2~3개 정도만 사용한다
- 나머지는 구체적 장면 상황 발견 질문 짧은 관찰로 바로 시작한다
- 다들 있지 이런 거 본 적 있어 같은 억지 공감 질문은 피한다
- 상품명을 첫 줄에 바로 넣지 않는다

[강력 금지 AI 광고 문장]
- 진짜 편리해 활용도도 높고 완전 좋아
- 스트레스가 확 줄어들 것 같아
- 간편하게 사용할 수 있어
- 활용도가 높아 실용적이야
- 생각보다 훨씬 괜찮아
- 완전 다른 세상
- 고소함이 진짜 대박이야 같은 추상 맛 총평
- 이 조합 예상 외로 맛있어 같은 결론형 문장
- 꼭 써봐 추천해 강추 무조건 사야 해
- 한 번 먹어봐야 해 놓치면 후회
- 제품의 기능을 2개 이상 줄줄이 나열하는 문장

[허구 경험 절대 금지]
- 입력 원문에 없는 남편 아내 시어머니 딸 아들 엄마 친구 직장동료 집들이 구매 사용 섭취 경험을 절대 만들지 않는다
- 특히 남편도 먹고 밥 두 공기 비웠어 우리 딸도 계속 손이 가더라 시어머니가 어디서 샀냐고 물어봤어 나도 해봤는데 집들이 때 반응 미쳤어 같은 문장을 원문 근거 없이 만들면 실패다
- 원문에 실제 관계나 사건이 있으면 그 사실만 짧게 사용할 수 있다
- 원문에 없는 1인칭 경험을 추가하지 않는다

[실제 Threads 호흡]
- 한 줄에 한 생각만 쓴다
- 한 줄은 대체로 8~26자
- 3~7줄 정도로 짧게 쓴다
- 1~2줄 뒤 실제 줄바꿈을 넣는다
- 문장끼리 설명적으로 이어 붙이지 않는다
- 정보보다 장면과 반응을 먼저 둔다
- ㅋㅋ ㅠㅠ ㅁㅊ ㄷㄷ 같은 표현은 소재에 맞을 때만 0~2회 쓴다
- ㅋㅋ를 매 글에 의무적으로 붙이지 않는다

[상품]
- 장면 → 눈에 띈 기능 하나 → 짧은 반응
- 편리함 활용도 실용성 장점 나열 금지
- 예: 소스통이 뚜껑에 붙어있네 / 따로 챙길 필요 없는 건 좀 괜찮다
- 위 예문의 사실은 복사하지 말고 호흡만 참고한다

[레시피]
- 음식 이름 설명 → 장점 나열 구조 금지
- 눈에 띄는 조합이나 조리 장면 → 짧은 맛 반응 → 필요하면 댓글 연결
- 맛 표현은 구체적으로 쓰되 풍미 완벽한 조화 촉촉함이 대박 같은 광고 묘사는 피한다
- 원문에 없는 가족 반응을 만들지 않는다
- 마지막은 필요할 때만 재료랑 만드는 법은 댓글에 적어둘게 정도로 끝낸다

[생활썰]
- 원문에 실제 있는 상황만 사용한다
- 문제나 발견 장면 → 짧은 반응 → 제품은 후반에 짧게
- 가짜 남편 친구 엄마 냄새 썰을 성공 공식처럼 붙이지 않는다

[기존 하드 규칙]
- ~냐 금지
- 음슴체 금지: 좋음 편함 했음 됐음 있음 없음 비움 미쳤었음 같은 종결 금지
- 존댓말 금지
- 문장 끝 마침표 금지
- 쉼표 금지
- 같은 감탄사 반복 금지
`;

axios.post = async function patchedReactionPost(url, data, config) {
  try {
    if (url === 'https://api.openai.com/v1/chat/completions' && Array.isArray(data?.messages)) {
      const messages = data.messages.map(m => ({ ...m }));
      const systemIndex = messages.findIndex(m => m.role === 'system');
      if (systemIndex >= 0 && /한국 Threads에서 실제 사람이 올린 것 같은 글을 만드는 최종 편집기/.test(String(messages[systemIndex].content || ''))) {
        messages[systemIndex].content = String(messages[systemIndex].content || '') + reactionGuide;
        data = { ...data, messages };
        console.log('[AutopilotV3][REACTION TONE] v8.1 human scene-first guide injected');
      }
    }
  } catch (e) {
    console.warn('[AutopilotV3][REACTION TONE] inject skipped:', e.message);
  }
  return originalPost(url, data, config);
};

console.log('[AutopilotV3][REACTION TONE] v8.1 scene-first anti-ad injector loaded');
