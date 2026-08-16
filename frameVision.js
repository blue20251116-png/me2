const axios = require('axios');
const { resolveModelKeys } = require('./aiCaption');
const { getAccount } = require('./db');

// 추출된 영상 프레임들을 OpenAI Vision으로 분석해서, Threads 게시 이미지로 쓰기 좋은 순서로
// 추천해주는 모듈. 사람의 실제 신원/유명인 이름은 절대 판별하지 않는다 — "사람이 잘 보이는
// 장면인가"만 평가한다. 실패해도 예외만 던지고(호출부가 catch해서 수동 선택으로 폴백), 여기서
// 완전자동화나 수동 흐름 전체를 막지 않는다.

const ALLOWED_CATEGORIES = ['person_hook', 'product_usage', 'product_closeup', 'general', 'bad'];
// 추천 우선순위: person_hook > product_usage > product_closeup > general (bad는 추천 제외)
const CATEGORY_PRIORITY = { person_hook: 0, product_usage: 1, product_closeup: 2, general: 3 };

function buildSystemPrompt() {
  return `너는 짧은 영상에서 추출한 정지 프레임들을 보고, Threads 게시용 사진으로 얼마나
적합한지 평가하는 사람이다.

각 프레임에 대해 다음만 평가한다:
- 사람이 명확하게 보이는가
- 제품이 명확하게 보이는가
- 실제 사용 장면인가
- 제품 클로즈업인가
- 화면이 흔들렸는가
- 화면 전환 중인가
- 자막/텍스트가 지나치게 가리는가
- 다른 프레임과 거의 중복인가
- 첫 장으로 시선을 끌 만한가
- Threads 게시 이미지로 자연스러운가

절대 하지 말 것 (매우 중요):
- 사람의 실제 신원을 식별하거나 추측하지 않는다
- 유명인 이름을 추측하거나 언급하지 않는다 (얼굴이 낯익어 보여도 이름을 쓰지 않는다)
- reason에도 이름이나 신원 추측을 절대 쓰지 않는다

각 프레임을 다음 카테고리 중 정확히 하나로 분류한다:
- person_hook: 인물이 잘 보이는 후킹 장면
- product_usage: 제품을 실제로 사용하는 장면
- product_closeup: 제품이 클로즈업된 장면
- general: 위 셋에 뚜렷이 속하지 않는 기타 장면
- bad: 흔들림/화면전환/검은화면/텍스트가 대부분을 가림 등 게시에 부적합한 장면

각 프레임에 0~100 사이 점수를 매긴다 (게시 이미지로서의 전반적 적합도).

각 이미지 앞에 "frameId: xxx" 텍스트가 주어진다. 응답에는 그 frameId를 정확히 그대로 사용하라.

출력은 아래 형식의 JSON 배열 하나만 반환한다. 다른 설명, 마크다운, 코드블록 표시 없이
JSON 배열 자체만 출력한다:
[{"frameId":"frame_01","category":"person_hook","score":92,"reason":"..."}]`;
}

// frames: [{id, url}] — url은 이미 이 계정 소유의 정상적인 추출 작업에서 생성된 공개 URL이어야 한다
// (호출하는 쪽(server.js)이 디스크에서 실제 존재를 확인한 프레임만 넘겨줄 것).
// 여러 이미지를 한 번의 요청에 묶어서 보낸다 (프레임 수만큼 API를 호출하지 않음).
async function analyzeFrames(accountId, frames) {
  if (!frames || !frames.length) return [];

  const account = getAccount(accountId);
  const { openaiKey } = resolveModelKeys(account);
  if (!openaiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다');
  }

  const content = [
    {
      type: 'text',
      text: `아래는 frameId와 이미지 ${frames.length}장이다. 규칙에 맞는 JSON 배열로만 응답하라.`,
    },
  ];
  for (const f of frames) {
    content.push({ type: 'text', text: `frameId: ${f.id}` });
    content.push({ type: 'image_url', image_url: { url: f.url } });
  }

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'content-type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI 분석 결과를 받지 못했습니다');

  const cleaned = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('AI 분석 결과를 해석할 수 없습니다');
  }
  if (!Array.isArray(parsed)) throw new Error('AI 분석 결과 형식이 올바르지 않습니다');

  const validFrameIds = new Set(frames.map((f) => f.id));
  return parsed
    .filter((r) => r && validFrameIds.has(r.frameId))
    .map((r) => ({
      frameId: r.frameId,
      category: ALLOWED_CATEGORIES.includes(r.category) ? r.category : 'general',
      score: Math.max(0, Math.min(100, Math.round(Number(r.score)) || 0)),
      // reason은 화면에만 참고로 보여주는 짧은 설명 — 길이만 방어적으로 제한
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '',
    }));
}

// 카테고리 우선순위 + 점수를 함께 반영해서 정렬한다. 단순 카테고리 우선이 아니라,
// 점수 차이가 크면(대략 20점 이상) 낮은 우선순위 카테고리가 역전할 수 있게 한다
// (예: person_hook 65점보다 product_usage 95점이 더 앞에 오도록).
// bad로 분류된 프레임은 추천 후보에서 제외한다 (삭제는 하지 않음 — 사용자가 원하면 직접 선택 가능).
function rankRecommendations(recommendations) {
  return recommendations
    .filter((r) => r.category !== 'bad')
    .map((r) => {
      const band = CATEGORY_PRIORITY[r.category] ?? 3;
      const weight = (3 - band) * 10 + r.score;
      return { ...r, _weight: weight };
    })
    .sort((a, b) => b._weight - a._weight)
    .map(({ _weight, ...rest }) => rest);
}

module.exports = { analyzeFrames, rankRecommendations, ALLOWED_CATEGORIES };
