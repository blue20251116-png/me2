const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, authorReplies = '', mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');
  const isRecipe = mode === 'recipe';

  const styleRules = `
한국 Threads에서 실제 사람이 바로 쓴 것처럼 작성한다.
가장 중요한 규칙:
- 원글의 정보와 소재는 참고하지만 문장은 새로 쓴다.
- 설명문, 리뷰문, 블로그 문체로 쓰지 않는다.
- AI식 감상/과장/정리 문장을 만들지 않는다.
- 한 문장을 길게 이어 쓰지 않는다. 한 줄은 대체로 짧게 쓴다.
- 전체 본문은 보통 4~8줄 정도로 끝낸다.
- 첫 1~2줄은 바로 상황이나 반응으로 시작한다.
- ㅋㅋ, ㅠㅠ, ㄷㄷ, ;;, ...는 원글 분위기에 맞을 때만 자연스럽게 사용한다.
- 자연스러운 반말을 사용한다. 음슴체(~함/~임/~됨)는 사용하지 않는다.
- 존댓말, 광고 카피, 전문가 설명체, 문학적인 표현을 사용하지 않는다.
- 같은 뜻을 다른 말로 반복하지 않는다.
- 원문에 없는 경험, 효능, 체중감량, 수치, 재료, 조리시간, 온도, 제품 성능을 절대 만들어내지 않는다.
- 5개 버전은 첫 문장과 전개를 다르게 한다.
`;

  const system = isRecipe
    ? `${styleRules}
레시피/음식 소재다.

[절대 규칙 - 사실 보존]
1. 원 게시물 내용과 작성자 추가 설명/댓글을 하나의 사실 자료로 읽는다.
2. 재료명, 양, 조리 순서, 시간, 온도, 도구는 자료에 실제로 적힌 것만 사용한다.
3. 자료에 없는 재료를 상식이나 다른 레시피 지식으로 보충하지 않는다.
4. 자료에 없는 수치도 추측하지 않는다.
5. 정보가 부족하면 부족한 그대로 쓰고 창작해서 채우지 않는다.
6. 원문에 '핵심재료'처럼 이름이 가려져 있으면 그대로 '핵심재료'라고 쓴다.

[본문 작성]
- 원글의 말투, 호흡, 후킹 강도를 참고해 짧은 Threads 글로 재작성한다.
- 레시피 전체를 본문에 설명하지 않는다.
- 블로그 후기 같은 '부드럽고 고급스럽다/건강 간식/반칙 아닌가/사르르 녹는다' 식의 AI 문구를 넣지 않는다.
- 실제 사람이 친구에게 말하듯 짧고 날것으로 쓴다.

[댓글 작성 - 매우 중요]
- comment는 원작자 댓글 요약이 아니라 새 게시물에 실제로 달 '레시피 댓글'이다.
- 길고 딱딱한 레시피 설명서처럼 쓰지 말고, 6~9줄 정도로 짧고 읽기 쉽게 쓴다.
- 첫 줄은 음식명/레시피명으로 시작해도 된다.
- 그 다음 줄부터 핵심 재료와 양을 짧게 이어 쓴다.
- 조리법은 2~4줄 안에 압축한다.
- 원글에서 특정 재료가 '맛 살리는 핵심', '이거 꼭', 상품 링크의 대상, 포인트 재료로 강조되어 있으면 그 재료를 댓글 마지막 1~2줄에서 다시 강조한다.
- 예: '여기서 진짜 중요한 게 들기름임 / 이거 마지막에 넣어야 고소한 맛이 확 살아남'처럼 자연스럽게 쓴다.
- 단, 어떤 재료가 핵심인지 자료에서 확인되지 않으면 임의로 핵심이라고 만들지 않는다.
- '~를 사용했음', '재료는 이것임', '준비물은 다음과 같음' 같은 기계적인 요약문은 금지한다.
- 광고 고지문과 링크는 comment에 만들지 않는다.

[원하는 댓글 결 예시]
🥚 푸딩 계란찜 레시피
계란 4개 + 끓는 물 200ml
소금 0.5T 넣고 중약불에 10분 정도 쪄주고
마지막에 진간장 1T + 들기름 1T 둘러주면 끝ㅋㅋ
여기서 진짜 중요한 게 들기름임
이거 마지막에 넣어야 고소한 맛이 확 살아남

위 예시는 '문체와 구조'만 참고한다. 실제 재료/양/시간은 반드시 현재 원문 자료에 있는 값만 사용한다.

반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":"레시피 댓글"}, ...]} 이고 정확히 5개를 만든다.`
    : `${styleRules}
생활/제품 소재다.
본문은 제품 설명이나 장점 목록이 아니라 실제 발견담/생활 썰처럼 쓴다.
원글에서 보이는 핵심 장면이나 불편, 반응을 앞에 두고 제품이나 방법은 뒤에서 자연스럽게 드러낸다.
본문은 4~8개의 짧은 줄을 권장한다.
반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":""}, ...]} 이고 정확히 5개를 만든다.`;

  const user = `키워드: ${String(keyword || '').trim()}

[원 게시물 - 사실 자료 A]
${String(sourceText || '').trim().slice(0, 5000)}

[같은 게시물 작성자가 직접 남긴 추가 설명/댓글 - 사실 자료 B]
${String(authorReplies || '').trim().slice(0, 5000) || '(추가 설명 없음)'}

A와 B에 실제로 존재하는 정보만 사실로 사용할 것.
특히 레시피라면 A에 재료와 만드는 법이 적혀 있어도 반드시 읽어서 comment에 반영할 것.
원문에서 특정 재료를 맛의 핵심/포인트로 강조했다면 comment 마지막에서 그 재료를 자연스럽게 한 번 더 강조할 것.
본문은 원글의 말투 결/문장 길이/템포를 참고해서 Threads스럽게 새로 쓰고, comment는 짧고 자연스러운 실제 댓글 형태로 작성해.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: isRecipe ? 0.28 : 0.88,
    max_tokens: isRecipe ? 4200 : 2600,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(x => ({ text: String(x?.text || '').trim(), comment: String(x?.comment || '').trim() })).filter(x => x.text).slice(0, 5)
    : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');
  return { items, texts: items.map(x => x.text), comments: items.map(x => x.comment || '') };
}

module.exports = { generateFromThreadsMaterial };
