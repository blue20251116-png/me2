const axios = require('axios');
const { db, getAccount, getSystemApiSettings } = require('./db');

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

function recentPosts(accountId, limit = 8) {
  try {
    return db.prepare(`SELECT text FROM posts WHERE account_id=? ORDER BY id DESC LIMIT ?`).all(accountId, limit)
      .map((r) => String(r.text || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function callOpenAI(accountId, system, user, maxTokens = 500) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature: 0.92, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 30000,
  });
  const text = res.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 결과를 받지 못했습니다');
  return text;
}

async function generateStoryCaption(accountId, { productName, price, target }) {
  const recent = recentPosts(accountId, 8);
  const system = `너는 한국 Threads에서 실제 사람이 순간적으로 올린 것 같은 쇼핑/생활 글을 쓴다.
현재 날짜: ${getKoreaDate()}

핵심 목표는 상품 설명이 아니라 "상황 먼저 → 제품이 자연스럽게 연상되는 썰"이다.
광고 카피, 쇼핑몰 후기, AI가 정리한 문장처럼 보이면 실패다.

[말투]
- 자연스러운 반말, 짧은 구어체, 4~7줄.
- 음슴체 금지. 문장 끝을 '~함/~임/~됨'으로 쓰지 않는다.
- ㅋㅋ/ㅎㅎ/?/...는 자연스러울 때만 0~2회.
- 너무 반듯하게 기승전결을 맞추지 않는다.
- 상품명, 브랜드명, 가격, 링크, 광고 고지는 본문에 넣지 않는다.

[시작 방식]
매번 아래 중 하나를 골라 다르게 시작한다: 예상 밖 반응, 귀찮음/불편, 발견, 충동, 반전, 혼잣말, 주변 상황, 짧은 썰.
"와 대박", "왜 이제 알았지", "이거 미쳤다" 같은 특정 훅을 연속으로 반복하지 않는다.

[내용]
- 기능을 줄줄이 설명하지 말고 사용 장면 하나로 보여준다.
- 제품 장점은 최대 1~2개만 자연스럽게 드러낸다.
- 실제로 제공되지 않은 친구/남편/아내/직장동료의 구체적인 말이나 실제 사용기간을 지어내지 않는다.
- 다만 특정 인물을 사실처럼 꾸미지 않는 범위의 일반적인 생활 상황은 가능하다.
- 건강/운동/뷰티/식품은 체중감량, 치료, 피부개선, 성기능 등 효과를 단정하지 않는다.
- 제공되지 않은 숫자, 후기 수, 기간, 성과를 만들지 않는다.
- "추천", "강추", "필수템", "꿀템", "구매하세요", "가성비 최고" 금지.
- 해시태그/제목/번호/이모지 나열 금지.

[마무리]
구매를 요구하지 않는다. 짧은 감상, 가벼운 궁금증, 여운으로 끝낸다.
매번 "궁금하면 댓글" 같은 CTA로 끝내지 않는다.

[중복 방지]
최근 게시물에 나온 첫 문장, 상황, 인물, 표현, 결말을 그대로 또는 비슷하게 반복하지 않는다.
특히 "미쳤다/대박/남편이/왜 이제 알았지/생각보다"가 최근 글에 반복되었으면 다른 표현을 쓴다.

출력은 Threads 본문만. 설명하지 않는다.`;

  const user = `상품: ${productName}
가격: ${price ? Number(price).toLocaleString('ko-KR') + '원' : '정보 없음'}
타겟: ${target || '전체'}

최근 게시물(표현/구조를 피할 것):
${recent.length ? recent.map((x, i) => `[${i + 1}] ${x}`).join('\n---\n') : '없음'}

이 상품에서 자연스럽게 이어지는 생활 상황 하나를 골라, 사람이 직접 쓴 것 같은 Threads 본문을 작성해. 상품 자체는 본문에서 노골적으로 공개하지 마.`;

  const text = await callOpenAI(accountId, system, user, 450);
  return text.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^\s*(버전|제목|본문)\s*\d*\s*[:：-]\s*/i, '').trim();
}

async function generateAffiliateLead(accountId, { postText }) {
  const system = `너는 한국 Threads 게시물 작성자가 자기 글 아래에 다는 첫 댓글을 쓴다.
광고문이 아니라 본문 말투 그대로 이어지는 짧은 댓글이어야 한다.

규칙:
- 1~3줄.
- 자연스러운 반말, 음슴체 금지.
- 본문을 반복하지 않는다.
- 제품 설명서처럼 스펙을 나열하지 않는다.
- 확인되지 않은 효능/수치/사용경험을 만들지 않는다.
- "추천/강추/필수템/꿀템/구매하세요" 금지.
- URL과 광고 고지는 쓰지 않는다. 서버가 뒤에 붙인다.
- "내가 본 건 이거", "이거 찾는 사람은 여기", "결국 이걸로 봄" 같은 자연스러운 연결은 가능하지만 같은 문구를 반복하지 않는다.
- 레시피 콘텐츠처럼 재료/조리법을 만들지 않는다.
- 출력은 댓글 문장만.`;
  const user = `본문:\n${postText}\n\n본문 바로 아래에 이어질 첫 댓글 연결 멘트만 작성해.`;
  const text = await callOpenAI(accountId, system, user, 180);
  return text.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^\s*(댓글|답글)\s*[:：-]\s*/i, '').trim();
}

module.exports = { generateStoryCaption, generateAffiliateLead };
