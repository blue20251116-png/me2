const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function detectRecipe(sourceText, authorReplies, requestedMode) {
  if (requestedMode === 'recipe') return true;
  const t = `${String(sourceText || '')}\n${String(authorReplies || '')}`.toLowerCase();
  const food = /(레시피|재료|양념|소스|계란|두부|고기|삼겹|닭|버섯|밥|면|파스타|샌드위치|아보카도|채소|야채|국|찌개|볶음|구이|간식|요리)/.test(t);
  const action = /(만드는\s*법|만드는방법|볶|굽|끓|튀기|찜|삶|썰|섞|버무|에어프라이어|전자레인지|중약불|약불|강불|분\s*정도|큰술|작은술|\d+\s*(?:t|ml|g|개|스푼|큰술|작은술))/i.test(t);
  return food && action;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, authorReplies = '', mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');
  const isRecipe = detectRecipe(sourceText, authorReplies, mode);

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

[줄바꿈 규칙 - 반드시 지킬 것]
- 본문을 한 덩어리로 붙여 쓰지 않는다.
- 1~2개의 짧은 문장을 쓴 뒤 빈 줄을 한 번 넣는다.
- 문단은 2~4개 정도로 나눈다.
- JSON 문자열 안에서도 실제 줄바꿈 문자를 사용해서 문단 간 한 줄 공백이 보이게 한다.
- 쉼표로 문장을 계속 이어붙이는 방식은 피한다.
- 모바일 Threads 화면에서 읽었을 때 숨이 막히지 않게 여백을 만든다.
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
- 블로그 후기 같은 AI 문구를 넣지 않는다.
- 실제 사람이 친구에게 말하듯 짧고 날것으로 쓴다.
- 1~2문장마다 빈 줄을 넣어서 읽기 편하게 만든다.

[댓글 작성 - 최우선 규칙]
댓글은 본문에 대한 감상이나 후기처럼 작성하지 않는다.
댓글 자체가 독자가 저장해서 바로 따라 할 수 있는 완성형 레시피가 되어야 한다.
본문 내용을 다른 말로 반복하는 댓글은 금지한다.
- 원본 콘텐츠와 작성자 추가 댓글에서 실제 재료, 양념, 소스, 계량, 조리법을 최대한 추출한다.
- 없는 내용을 임의로 보충하지 않는다.
- 재료명과 계량은 원문에 있는 범위에서 최대한 구체적으로 적는다.
- 조리 과정은 실제 따라 할 수 있도록 순서대로 작성한다.
- 특정 재료/소스가 핵심으로 강조되어 있으면 마지막 '💡 진짜 포인트'에서 자연스럽게 강조한다.
- 광고 고지문과 제휴 링크 자체는 comment에 생성하지 않는다. 링크는 별도 시스템이 붙인다.
- 원문 정보가 부족하면 존재하지 않는 섹션을 억지로 채우지 않는다.
- '재료는 따로 없음', '그냥 먹으면 됨', '효과 짱임' 같은 근거 없는 문장은 금지한다.
- 음슴체는 금지한다.

[댓글 기본 출력 구조]
원문에 해당 정보가 있는 항목만 사용한다.

🥑 준비재료
✔ 재료 + 실제 양

✨ 소스
✔ 소스/양념 + 실제 양

👩🏻‍🍳 만드는 방법
1️⃣ 실제 조리 단계
2️⃣ 실제 조리 단계
3️⃣ 실제 조리 단계

💡 진짜 포인트
원문에 실제 나온 핵심 팁을 1~2문장으로 쓴다.

[댓글 예시 - 형식만 참고]
🥚 푸딩 계란찜 레시피

✔ 계란 4개
✔ 끓는 물 200ml
✔ 소금 0.5T

✨ 마지막 소스
✔ 진간장 1T
✔ 들기름 1T

👩🏻‍🍳 만드는 방법
1️⃣ 계란을 잘 풀어준다.
2️⃣ 끓는 물을 조금씩 넣으면서 섞어준다.
3️⃣ 소금으로 간을 맞춘다.
4️⃣ 중약불에서 10분 정도 쪄준다.
5️⃣ 마지막에 진간장과 들기름을 둘러주면 끝ㅋㅋ

💡 진짜 포인트
여기서 중요한 게 들기름임.
다 찐 다음 마지막에 넣어야 고소한 맛이 확 살아남.

위 예시는 문체와 구조만 참고하고 실제 정보는 현재 원문 자료에 있는 값만 사용한다.
반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":"레시피 댓글"}, ...]} 이고 정확히 5개를 만든다.`
    : `${styleRules}
생활/제품 소재다.
본문은 제품 설명이나 장점 목록이 아니라 실제 발견담/생활 썰처럼 쓴다.
원글에서 보이는 핵심 장면이나 불편, 반응을 앞에 두고 제품이나 방법은 뒤에서 자연스럽게 드러낸다.
본문은 4~8개의 짧은 줄을 권장한다.
1~2문장마다 빈 줄을 넣어 문단을 나눈다.

[댓글 작성 - 반드시 작성]
- comment를 빈 문자열로 두지 않는다.
- 같은 작성자가 원 게시물 아래에 남긴 추가 설명/댓글이 있으면 그 정보를 최우선으로 참고한다.
- 본문을 반복하는 감상 댓글이 아니라, 독자에게 도움이 되는 추가 정보/사용법/핵심 포인트를 2~6줄로 쓴다.
- 작성자 추가 댓글에 구체적인 사용법, 구성, 방법, 주의점이 있으면 빠뜨리지 않는다.
- 원문과 작성자 댓글에 없는 정보는 만들지 않는다.
- 링크와 광고 고지문은 comment에 넣지 않는다. 제휴 링크/고지문은 별도 시스템이 붙인다.
- 추가 정보가 거의 없더라도 원문에서 확인되는 핵심 포인트를 짧게 정리해서 comment를 반드시 만든다.
- '재료 · 만드는 법 · 추가 설명이 여기에 들어갑니다' 같은 placeholder 문구는 절대 출력하지 않는다.
- 음슴체는 사용하지 않는다.

반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":"추가 설명 댓글"}, ...]} 이고 정확히 5개를 만든다.`;

  const user = `키워드: ${String(keyword || '').trim()}

[원 게시물 - 사실 자료 A]
${String(sourceText || '').trim().slice(0, 5000)}

[같은 게시물 작성자가 직접 남긴 추가 설명/댓글 - 사실 자료 B]
${String(authorReplies || '').trim().slice(0, 5000) || '(추가 설명 없음)'}

A와 B에 실제로 존재하는 정보만 사실로 사용할 것.
레시피로 판단되면 A와 B 전체를 읽고 재료, 계량, 소스, 조리 순서, 핵심 포인트를 comment에 최대한 빠짐없이 반영할 것.
일반 상품/생활 소재여도 comment를 비우지 말고 B의 추가 설명을 우선 반영해 유용한 후속 댓글을 작성할 것.
원문에 없는 재료, 계량, 효능, 체중 변화, 경험은 절대 추가하지 말 것.
본문은 원글의 말투 결/문장 길이/템포를 참고해서 Threads스럽게 새로 쓰되 1~2문장마다 빈 줄을 넣어 읽기 좋게 만들 것.
comment도 한 덩어리로 붙이지 말고 읽기 쉽게 줄을 나눌 것.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: isRecipe ? 0.22 : 0.78,
    max_tokens: isRecipe ? 4800 : 3200,
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

  // 모든 소재는 후속 댓글을 가져야 한다. 모델이 비운 경우에는 원문/작성자 댓글의
  // 확인 가능한 내용만 사용해 짧은 fallback 댓글을 만든다.
  const fallbackSource = String(authorReplies || sourceText || '').replace(/\s+/g, ' ').trim();
  for (const item of items) {
    if (!item.comment) {
      item.comment = fallbackSource
        ? fallbackSource.slice(0, 420)
        : '원문에서 확인되는 추가 정보가 없어 본문 내용만 참고해주세요.';
    }
  }

  return { mode: isRecipe ? 'recipe' : 'product', items, texts: items.map(x => x.text), comments: items.map(x => x.comment) };
}

module.exports = { generateFromThreadsMaterial };
