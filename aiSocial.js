const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function getKoreaDate() {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

async function callOpenAI(accountId, system, user, maxTokens = 500) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.95,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 결과를 받지 못했습니다');
  return text;
}

async function generateStoryCaption(accountId, { productName, price, target }) {
  const system = `너는 한국 Threads에서 사람이 직접 쓴 것 같은 짧은 생활 공감글을 쓴다.

현재 날짜: ${getKoreaDate()}

이 글의 목적은 상품 광고문을 만드는 것이 아니다.
상품에서 연상되는 "생활 속 불편/공감/고민" 하나만 뽑아 짧은 Threads 글로 만든다.

필수 규칙:
- 3~7줄.
- 반말, 짧은 구어체.
- 상품명/브랜드명/가격/구매링크를 본문에 직접 쓰지 않는다.
- "장점", "품질", "활용도", "추천", "필수템", "꿀템", "나만 그런가?" 같은 AI 광고 문투 금지.
- 제품 설명을 하지 않는다.
- 마지막에 억지 질문으로 끝내지 않아도 된다.
- 현재 계절과 맞지 않는 상황을 만들지 않는다.
- 실제 날씨(비/눈/폭염/한파)는 제공되지 않았으므로 단정하지 않는다.
- 친구/남편/아내/회사동료가 실제로 추천했다는 식의 구체적인 인물 경험을 임의로 만들지 않는다.
- "몇 주 써봤다", "효과 봤다", "피부가 좋아졌다", "살 빠졌다" 등 가짜 후기/효능을 만들지 않는다.
- 화장품을 먹거나 마신다고 쓰지 않는다. 상품 사용법을 확신할 수 없으면 사용법 자체를 구체적으로 쓰지 않는다.
- 건강/뷰티/식품은 효능을 주장하지 않는다.
- 글만 읽으면 일반 생활 공감글처럼 보여야 한다.
- ㅋㅋ는 필요할 때 0~1회 정도만 자연스럽게.
- 제목/번호/해시태그/이모지/광고표시 문구는 넣지 않는다.

좋은 결:
"요리 한번 하고 나면
닦을 게 왜 이렇게 많이 생기는지 모르겠음
요리보다 뒷정리가 더 귀찮다"

"분명 정리했는데
며칠만 지나면 또 원상복구됨
집이 문제인지 내가 문제인지 모르겠음"

너무 매끈한 문장보다 실제 사람이 툭 쓴 느낌을 우선한다.`;

  const user = `상품: ${productName}
가격: ${price ? Number(price).toLocaleString('ko-KR') + '원' : '정보 없음'}
타겟: ${target || '전체'}

이 상품에서 자연스럽게 연결될 수 있는 생활 공감 상황 하나만 골라 본문을 작성해.
상품 자체는 본문에서 공개하지 마.`;

  const text = await callOpenAI(accountId, system, user, 450);
  return text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^\s*(버전|제목|본문)\s*\d*\s*[:：-]\s*/i, '')
    .trim();
}

async function generateAffiliateLead(accountId, { postText }) {
  const system = `너는 한국 Threads 게시물의 첫 댓글을 쓴다.
본문의 이야기를 이어서 "그래서 내가 본/고른 상품이 이거"라는 느낌의 연결 멘트만 작성한다.

규칙:
- 1~2줄만.
- 자연스러운 반말.
- 본문과 같은 말을 길게 반복하지 않는다.
- 상품 기능/효능/스펙을 새로 지어내지 않는다.
- 실제로 써봤다는 거짓 후기를 만들지 않는다.
- "추천", "강추", "구매하세요", "필수템", "꿀템" 금지.
- 광고표시 문구와 URL은 절대 쓰지 않는다. 서버가 뒤에 따로 붙인다.
- "내가 본 건 이거", "결국 찾아본 건 이거", "그래서 이번엔 이걸로 봄" 같은 결은 가능하되 매번 같은 문구를 반복하지 않는다.
- ㅋㅋ는 필요할 때 한 번 정도만.
- 출력은 댓글 문장만.`;

  const user = `본문:
${postText}

이 본문 바로 아래에 달 첫 댓글의 연결 멘트만 써줘.`;

  const text = await callOpenAI(accountId, system, user, 180);
  return text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^\s*(댓글|답글)\s*[:：-]\s*/i, '')
    .trim();
}

module.exports = {
  generateStoryCaption,
  generateAffiliateLead,
};
