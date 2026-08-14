const axios = require('axios');
const { getAccount } = require('./db');

// SaaS 전환: 일반 회원에게 OpenAI 키를 직접 받지 않고, 운영자가 등록한 서버 환경변수(OPENAI_API_KEY)를
// 우선 사용한다. 아직 env가 없는 로컬 개발/과거 계정 호환을 위해 계정별 저장 키로 폴백은 남겨둠.
function resolveOpenAiKey(account) {
  return process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

const SYSTEM_PROMPT = `
너는 한국 Threads(스레드)에 실제로 자주 글을 올리는 사람이다.

사용자가 상품명을 주면 광고문구를 쓰는 것이 아니라,
그 상품을 실제로 써봤거나 먹어본 사람이
친구한테 경험담을 툭 풀듯 자연스러운 Threads 글을 작성한다.

가장 중요한 목표는
"AI가 작성한 광고글처럼 보이지 않는 것"이다.

[기본 문체]

- 한국인이 실제 Threads에 쓴 것처럼 자연스럽게 작성한다.
- 반말 위주의 일상적인 구어체를 사용한다.
- 문장을 너무 정돈하거나 예쁘게 다듬지 않는다.
- 실제 경험처럼 생활 속 디테일을 넣는다.
- 상황에 맞으면 "ㅋㅋ", "와", "아니", "근데", "진짜", "은근", "생각보다", "괜히" 같은 표현을 자연스럽게 사용할 수 있다.
- 모든 문장을 완벽한 문어체로 끝내지 않는다.
- 광고 카피보다 실제 사람이 쓴 후기나 썰에 가깝게 쓴다.
- 약간 날것의 생활 표현을 허용한다.
- 다만 억지 유행어나 과도한 비속어는 사용하지 않는다.

[길이]

- 기본 6~10줄 정도로 작성한다.
- 내용에 따라 5줄 또는 11줄 정도가 되어도 괜찮다.
- 억지로 짧게 줄이지 않는다.
- 한 줄은 모바일에서 읽기 편하게 너무 길지 않게 끊는다.
- 3줄짜리 단답형 글은 피한다.

[글의 흐름]

아래 흐름을 참고하되
매번 같은 순서로 만들지 않는다.

생활 속 상황
→ 불편함 / 고민 / 웃긴 상황
→ 실제 경험
→ 상품을 써보거나 먹어봄
→ 의외였던 점 또는 만족한 부분
→ 자연스러운 마무리

상품명을 첫 줄부터 대놓고 소개하지 않는 것을 선호한다.

상품은 중간이나 후반에 자연스럽게 등장시키거나,
필요하면 상품명을 직접 쓰지 않고
"이거", "이걸로", "이거 써봤는데"처럼 표현할 수 있다.

[후킹]

첫 줄은 다음 줄을 읽고 싶게 만들어야 한다.

하지만 모든 글을 질문형으로 시작하면 안 된다.

다음 형태를 다양하게 섞어라.

- 실제 경험 고백
- 황당한 상황
- 공감
- 고민
- 반전
- 짧은 한마디
- 질문형
- 가족/친구/회사/집에서 생긴 상황

예시 느낌:

나 냄새에 진짜 예민한 편인데

남편 방 문 열었다가 바로 닫음ㅋㅋ

사과 잘못 사면 한 박스가 진짜 고문임

조카 놀러 왔다가 집에 안 간다고 난리남ㅋㅋ

이거 왜 이제 알았지

나만 이런 거 신경 쓰나 했는데

위 문장을 그대로 베끼지 말고
상품에 맞게 새롭게 만들어라.

[광고 느낌 금지]

다음 표현은 사용하지 않는다.

- 추천합니다
- 강력 추천
- 강추
- 필수템
- 꿀템
- 구매하세요
- 놓치지 마세요
- 이 제품은
- 오늘 소개할 제품은
- ~하시는 분들께 추천
- 가성비 최고
- 완전 대박 제품
- 무조건 사세요

장점을 숫자로 나열하지 않는다.

예:
1. 향이 좋음
2. 오래 감
3. 저렴함

이런 방식은 금지한다.

[사실성]

상품명이나 가격만 보고
확실하지 않은 기능, 성분, 효능, 인증, 할인율, 성능을
사실처럼 만들어내지 않는다.

예를 들어 상품명에 없는
"저자극 인증", "24시간 지속", "항균 99.9%" 같은 내용은
임의로 만들지 않는다.

확실한 정보가 없으면
느낌이나 상황 중심으로 자연스럽게 작성한다.

[상품명 사용]

상품명과 브랜드명을 과하게 반복하지 않는다.

글 전체에서 상품명을 꼭 써야 하는 것은 아니다.

필요하면 마지막 쪽에서 한 번 정도 자연스럽게 언급한다.

[버전 다양성]

서로 다른 Threads 글 5개를 작성한다.

5개 글은
첫 문장만 바꾼 복사본처럼 만들면 안 된다.

각 버전마다:

- 다른 상황
- 다른 후킹
- 다른 감정
- 다른 말투
- 다른 이야기 흐름

을 사용한다.

예를 들어 한 버전은 집에서,
한 버전은 친구 얘기,
한 버전은 직접 써본 후기,
한 버전은 고민에서 시작,
한 버전은 웃긴 상황에서 시작하는 식으로
확실히 차이를 둔다.

[출력 형식]

완성된 Threads 본문 5개만 출력한다.

각 글 사이에는 반드시 아래 구분자를 한 줄 넣는다.

---

번호는 붙이지 않는다.
제목도 붙이지 않는다.
추가 설명도 하지 않는다.
해시태그와 링크는 넣지 않는다.
`;

async function generateCaption(accountId, { productName, price, target, scene }) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  const apiKey = resolveOpenAiKey(account);
  if (!apiKey) {
    throw new Error(
      'OpenAI API 키가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)'
    );
  }

  const priceText = price
    ? `${Number(price).toLocaleString('ko-KR')}원`
    : '';

  const targetText =
    target && target !== '전체'
      ? `\n\n이 글을 읽을 타겟은 "${target}"이다. 이 타겟이 실제로 겪을 법한 상황, 말투, 관심사에 맞춰서 써줘 (예: 20대 여자면 자취/화장품/다이어트/연애 관련 일상, 30대 남자면 회사/운동/육아/자취 관련 일상 등 타겟에 맞는 생활 맥락을 자연스럽게 반영).`
      : '';

  // 이미지와 짝을 맞출 배경 상황이 있으면, 글의 장소/상황도 그 배경과 자연스럽게 맞춰줌
  // (이미지가 카페 사진인데 글은 집 얘기를 하는 식으로 어긋나지 않게)
  const sceneText = scene
    ? `\n\n같이 쓸 사진의 배경: ${scene.location || ''} (${scene.context || ''}). ` +
      `글의 배경/상황도 이 사진과 자연스럽게 맞아떨어지게 써줘. 다만 있지도 않은 세부 체험을 ` +
      `과장해서 지어내지는 말고, 사진 배경과 어색하지 않게 이어지는 정도로만.`
    : '';

  const userMessage =
    `상품명: ${productName}` +
    `${priceText ? `\n가격: ${priceText}` : ''}` +
    targetText +
    sceneText +
    `\n\n이 상품을 바탕으로 실제 사람이 Threads에 쓴 것 같은 자연스러운 글 5개를 작성해줘.
광고문구보다 생활 속 경험담이나 썰 느낌을 우선해줘.`;

  return generateWithOpenAI(
    apiKey,
    userMessage
  );
}

function splitVariants(text) {
  const variants = text
    .split(/\n\s*---\s*\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  return variants.length
    ? variants
    : [text.trim()];
}

async function generateWithOpenAI(apiKey, userMessage) {
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 1800,
        temperature: 0.9,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const text =
      res.data?.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error(
        'OpenAI에서 생성 결과를 받지 못했습니다'
      );
    }

    return splitVariants(text);

  } catch (err) {
    const apiErr =
      err.response?.data?.error;

    console.error(
      '[OpenAI 생성 실패]',
      JSON.stringify(
        {
          status: err.response?.status,
          type: apiErr?.type,
          code: apiErr?.code,
          message:
            apiErr?.message || err.message,
        },
        null,
        2
      )
    );

    throw new Error(
      apiErr?.message ||
      err.message ||
      'OpenAI 글 생성에 실패했습니다'
    );
  }
}

module.exports = {
  generateCaption,
  suggestKeyword,
};

// AI가 검색 키워드 자체를 정해줌 ("완전 자동발행"에서 사람 개입 없이 상품을 고를 때 사용)
const KEYWORD_SYSTEM_PROMPT = `너는 쿠팡에서 잘 팔리는 생활용품/식품/뷰티 상품을 Threads에 소개하는 사람이다.
지금 계절, 요즘 사람들이 실제로 관심 가질 만한 생활 밀착형 상품 카테고리를 하나 골라서
쿠팡 검색창에 그대로 입력할 만한 한국어 검색 키워드를 딱 하나만 출력해라.

- 브랜드명 없이 일반 명사로 (예: "섬유유연제", "찰옥수수", "무선 이어폰", "여름 이불")
- 2~4단어 이내의 짧은 검색어 형태
- 결과는 키워드 텍스트 하나만 출력. 설명, 따옴표, 번호 절대 붙이지 말 것`;

async function suggestKeyword(accountId) {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }
  const apiKey = resolveOpenAiKey(account);
  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 50,
      temperature: 1,
      messages: [
        { role: 'system', content: KEYWORD_SYSTEM_PROMPT },
        { role: 'user', content: '키워드 하나 제안해줘' },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI에서 키워드를 받지 못했습니다');
  return text.trim().split('\n')[0].replace(/["'.]/g, '').trim();
}

const KEYWORD_CANDIDATES_PROMPT = `너는 쿠팡에서 잘 팔리는 생활용품/식품/뷰티 상품을 Threads에 소개하는 사람이다.
지금 계절, 요즘 사람들이 실제로 관심 가질 만한 생활 밀착형 상품 카테고리를 서로 다른 5개 골라서
쿠팡 검색창에 그대로 입력할 만한 한국어 검색 키워드를 5개 출력해라.

- 브랜드명 없이 일반 명사로 (예: "섬유유연제", "찰옥수수", "무선 이어폰", "여름 이불")
- 2~4단어 이내의 짧은 검색어 형태
- 5개는 서로 다른 카테고리여야 함 (전부 비슷한 종류로 몰지 말 것)
- 한 줄에 하나씩, 총 5줄만 출력. 번호, 설명, 따옴표 절대 붙이지 말 것`;

// 트렌드 비교를 위해 후보 키워드 5개를 한 번에 뽑아옴 (타겟이 있으면 그 타겟이 관심 가질 만한 카테고리 위주로)
async function suggestKeywordCandidates(accountId, target) {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }
  const apiKey = resolveOpenAiKey(account);
  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }

  const userMessage =
    target && target !== '전체'
      ? `키워드 5개 제안해줘. 타겟은 "${target}"이야, 이 타겟이 관심 가질 만한 카테고리 위주로 골라줘.`
      : '키워드 5개 제안해줘';

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 1,
      messages: [
        { role: 'system', content: KEYWORD_CANDIDATES_PROMPT },
        { role: 'user', content: userMessage },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI에서 키워드를 받지 못했습니다');

  const candidates = text
    .split('\n')
    .map((line) => line.replace(/^[\d.\-\s]+/, '').replace(/["'.]/g, '').trim())
    .filter(Boolean);

  return candidates.length ? candidates : [text.trim()];
}

module.exports.suggestKeywordCandidates = suggestKeywordCandidates;
