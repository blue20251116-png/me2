const engine = require('./autopilotMaterialEngine');

const previousBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function looksLikeDryExplanation(text) {
  const t = String(text || '');
  if (!t) return false;
  const dry = /(편하다|편해|걱정 없|알아서|사용하|사용할|두고 쓰|기능|방식|가능하|필요 없|도움|유용하|쉽게|간단하|효과적)/g;
  const reactions = /(ㅋㅋ|ㅎㅎ|;;|ㄷㄷ|ㅁㅊ|존맛탱|개맛|개편|탐난|뭐야|신기|미쳤|대박|와\b|아니\b)/g;
  const dryCount = (t.match(dry) || []).length;
  const reactionCount = (t.match(reactions) || []).length;
  return dryCount >= 2 && reactionCount === 0;
}

function addReactionHint(result) {
  if (!result?.text || !looksLikeDryExplanation(result.text)) return result;
  // 기존 HUMAN FINAL이 이미 작성한 사실은 그대로 두고 다음 생성/재시도에서
  // 설명문을 정상 결과로 오인하지 않도록 표시한다
  console.log('[AutopilotV3][REACTION TONE] dry explanation detected');
  return result;
}

engine.buildThreadsFirstAutopilot = async function reactionToneBuild(accountId, args = {}) {
  const result = await previousBuild(accountId, args);
  return addReactionHint(result);
};

// HUMAN FINAL 프롬프트가 참조할 수 있도록 전역 스타일 가이드 제공
// Gemini/OpenAI compatibility patch 여부와 무관하게 문자열만 제공한다
global.__THREADS_REACTION_STYLE_V6 = `
실제 한국 Threads 피드의 반응형 말투를 우선한다
설명문이나 제품 기능 요약처럼 쓰지 않는다
영상이나 사진에서 제일 눈에 띄는 한 장면을 먼저 반응한다
그 다음 핵심 사실 한두 개만 짧게 붙인다
마지막은 총평 대신 사람 반응처럼 끝낸다

허용되는 반응 표현 예시
- 신기한 상품: ㅁㅊㅋㅋ ㄷㄷ 아니 이걸 왜 만들었어ㅋㅋ 이건 좀 탐난다 개편하겠다
- 음식/레시피: 존맛탱 개맛있겠다 이 조합 뭐야ㅋㅋ 이건 맛없기 힘들겠다
- 의외의 기능: 와 이게 되네ㅋㅋ 뭐야 이거;; 생각보다 괜찮은데

중요
- 위 표현을 매번 강제로 넣지 않는다
- 같은 시작과 같은 유행어를 연속 반복하지 않는다
- 소재와 감정에 맞는 표현만 0~2개 자연스럽게 선택한다
- 정보만 나열하는 설명문은 실패다
- '설거지도 편하다' '사용하기 편하다' '걱정 없다' 같은 정리형 결론을 피한다
- 입력에 없는 구매 사용 섭취 가족 친구 경험을 만들지 않는다
- ~냐 금지
- 일반 음슴체 금지
- 문장 끝 마침표 쉼표 금지
`;

console.log('[AutopilotV3][REACTION TONE] v6 natural slang guide loaded');
