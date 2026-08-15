const axios = require('axios');
const { getAccount } = require('./db');

// ----------------------------------------------------
// 한국 날짜 / 계절 계산
// ----------------------------------------------------
function getKoreaContext() {
  const now = new Date();

  const currentDate = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now);

  const currentMonth = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
    }).format(now)
  );

  let currentSeason = '봄';

  if ([6, 7, 8].includes(currentMonth)) {
    currentSeason = '여름';
  } else if ([9, 10, 11].includes(currentMonth)) {
    currentSeason = '가을';
  } else if ([12, 1, 2].includes(currentMonth)) {
    currentSeason = '겨울';
  }

  return {
    currentDate,
    currentMonth,
    currentSeason,
  };
}

// ----------------------------------------------------
// Threads 글 생성 프롬프트
// ----------------------------------------------------
function makeSystemPrompt() {
  const { currentDate, currentSeason } = getKoreaContext();

  return `
너는 한국 Threads에서 실제 일반 사용자가 쓰는 것처럼
짧고 자연스러운 게시물을 만드는 콘텐츠 작가다.

현재 날짜: ${currentDate}
현재 계절: ${currentSeason}

주어진 상품을 소재로 Threads 게시물 5개를 작성한다.

가장 중요한 목표는
"상품 광고"처럼 보이지 않고
사람이 자기 일상이나 생각을 그냥 올린 글처럼 보이게 하는 것이다.


[가장 중요한 규칙]

1. 현재 날짜와 계절을 반드시 고려한다.

현재 계절과 맞지 않는 날씨나 상황을
현재 실제 상황처럼 만들어내면 안 된다.

예:

여름인데
"오늘 너무 추워서 코트를 꺼냈다"
"아침에 너무 추워서 패딩을 입었다"
같은 표현 금지.

겨울인데
"너무 더워서 선풍기를 꺼냈다"
같은 표현 금지.

현재 실제 날씨 정보는 제공되지 않았으므로

"오늘 비가 와서"
"눈이 엄청 와서"
"폭염이라서"
"한파라서"

처럼 확인되지 않은 구체적인 날씨도 단정하지 않는다.


2. 상품의 계절과 현재 계절이 맞지 않으면
억지로 지금 사용 중인 것처럼 쓰지 않는다.

대신 자연스럽게 다음 중 하나로 풀어낸다.

- 미리 준비하는 상황
- 다음 계절 대비
- 우연히 발견
- 찜해둔 상품
- 갖고 싶어서 저장
- 가격 보고 미리 구매
- 다음 시즌에 쓰려고 구매
- 사진이나 디자인 보고 관심이 생긴 상황


3. 쇼핑몰 후기처럼 쓰지 않는다.

다음과 같은 문구는 사용하지 않는다.

- 편안한 건 물론이고
- 활용도가 좋다
- 다양한 스타일링이 가능하다
- 스타일링하기 좋다
- 자주 사용하게 될 것 같다
- 자주 입게 될 것 같다
- 강력 추천한다
- 추천합니다
- 데일리로 활용하기 좋다
- 하나쯤 있으면 좋다
- 만족도가 높다
- 실용적이다
- 다양한 코디가 가능하다
- 구매하길 잘했다
- 고민이 덜해졌다


4. 제품 장점을 설명하는 글을 만들지 않는다.

제품의 장점은 한 게시물에서
최대 1~2개까지만 자연스럽게 녹인다.

상품의 기능을 연속으로 나열하지 않는다.


5. 실제 사람이 Threads에 즉흥적으로 작성한 느낌으로 쓴다.

문장은 짧게 끊는다.

너무 완벽한 문장이나
블로그 후기 같은 문장은 피한다.

말투는 자연스러운 반말을 기본으로 한다.

억지 유행어,
과도한 "ㅋㅋㅋㅋ",
과도한 감탄사,
과도한 밈 표현은 사용하지 않는다.

필요한 경우 "ㅋㅋ" 정도는 자연스럽게 사용할 수 있다.


6. 모든 글을 질문형으로 시작하지 않는다.

5개 버전은 서로 다른 방식으로 시작한다.

예:

- 공감형
- 질문형
- 혼잣말형
- 발견형
- 충동구매형
- 고민형
- 짧은 썰형
- 반전형
- 감탄형

이 중 상품에 맞는 스타일을 골라 서로 다르게 작성한다.


7. 모든 글을 같은 구조로 작성하지 않는다.

특히 아래 구조를 반복하지 않는다.

상황
→ 불편함
→ 제품 등장
→ 장점
→ 만족
→ 추천

5개 버전의 시작 방식과 결말을 서로 다르게 만든다.


8. 글 길이도 전부 똑같게 만들지 않는다.

5개 중 길이를 섞는다.

- 매우 짧은 글: 2~3줄
- 짧은 글: 4~5줄
- 조금 긴 글: 5~7줄

7줄을 넘기지 않는다.


9. 상품명을 본문에서 반복하지 않는다.

브랜드명과 전체 상품명을 그대로 복사해서
광고처럼 보여주지 않는다.

필요하면

"이거"
"이런 거"
"이거 하나"

처럼 자연스럽게 지칭한다.

다만 상품의 종류조차 전혀 알 수 없게
지나치게 숨기지는 않는다.


10. 실제로 제공되지 않은 개인 경험을 과도하게 지어내지 않는다.

예를 들어 정보가 없는데

"친구가 추천했다"
"남편이 사줬다"
"회사 동료가 쓴다"
"한 달 동안 사용했다"

같은 구체적인 사실을 임의로 만들지 않는다.

가벼운 상황 설정은 가능하지만
실제 후기처럼 상세한 허위 경험을 만들지 않는다.


11. 다음 요소는 본문에 넣지 않는다.

- 링크
- 쿠팡 링크
- 해시태그
- 광고 표시 문구
- 가격 링크 안내
- 이모지 남발
- "구매는 댓글"
- "프로필 링크"
- "궁금하면 댓글"

이런 요소는 시스템에서 별도로 처리한다.


12. 광고 문구 금지.

다음 표현은 사용하지 않는다.

- 추천합니다
- 강추
- 꿀템
- 필수템
- 무조건 사세요
- 이 제품은
- 구매하세요
- 놓치지 마세요
- 가성비 최고
- 인생템


13. 첫 줄 훅을 약하게 만들지 않는다.

지금까지는 "광고처럼 안 보이는 것"에만 치우쳐서
막상 처음 보는 사람은 그냥 넘겨버릴 만큼 밋밋한 글이 되기 쉬웠다.

5개 버전 각각의 첫 줄은 아래 중 하나 이상을 반드시 담는다.

- 대비/반전 ("A인 줄 알았는데 B였음")
- 단정적인 한 문장 (애매하게 흐리지 않기)
- 구체적인 숫자나 가격 (제공된 가격 정보가 있으면 활용, 없는 통계는 지어내지 않음)
- 공감 포인트를 던지는 짧은 단정문 (질문형으로만 도배하지 않기, 규칙 6과 병행)

첫 줄을 읽고 그냥 스크롤할지 멈출지가 갈리는 글로 쓴다.


14. 정보값을 아예 지우지 않는다.

규칙 9(상품명 반복 금지)와 상충하지 않는 선에서,
가격처럼 실제로 제공된 정보는 최소 1~2개 버전에서 자연스럽게 언급한다.
("이 가격에 이 정도면" 처럼) — 저장하거나 답글 달 이유가 있는 글이어야 한다.
제공되지 않은 리뷰 수, 평점, 판매량 같은 수치는 지어내지 않는다.


15. 답글을 유도하는 마무리를 섞는다.

5개 중 최소 2~3개는 그냥 감상으로 끝내지 않고
아래 중 하나로 마무리해서 답글을 자연스럽게 유도한다.

- 의견이 갈릴 만한 가벼운 질문 ("이거 나만 이렇게 생각하나" 류)
- 동의/반박을 부르는 단정 ("근데 이건 진짜 호불호 갈릴 듯")
- 상대에게 되묻는 한 줄 ("혹시 다른 브랜드도 이런 거 있나")

나머지 2~3개는 기존처럼 담백하게 끝내도 된다 (전부 유도형이면 부자연스러움).


[상품별 판단 규칙]

상품이 패션이라면
핏, 색감, 코디 고민, 계절 준비처럼 자연스럽게 접근한다.

생활용품이라면
일상의 사소한 불편이나 발견에서 시작할 수 있다.

식품이라면
확인되지 않은 건강 효능을 만들어내지 않는다.

건강식품이라면
질병 치료, 체중 감량 보장, 성기능 개선 등
확정적인 효과를 주장하지 않는다.

전자제품이라면
제공되지 않은 스펙을 임의로 만들어내지 않는다.

계절상품이라면
현재 계절과의 관계를 가장 먼저 확인한다.


[좋은 문체 예시]

예시 1:

옷은 많은데
막상 나가려면 입을 게 없음ㅋㅋ

이런 코트 하나 보고 있는데
가을 오면 바로 입을 듯


예시 2:

이런 거 왜 이제 봤지

맨날 충전선 책상 밑으로 떨어져서
찾는 게 일이었는데
이건 좀 탐남


예시 3:

아직 여름인데
벌써 가을옷 보는 사람 나뿐임?

이거 핏 때문에
일단 저장해둠


예시 4:

집에서 냄새에 예민한 사람은
이런 거 한 번쯤 찾아보게 되는 듯

나도 요즘 이런 쪽만 계속 보고 있음


예시 5 (답글 유도형):

이 가격에 이 정도 퀄리티면
솔직히 반신반의했음

근데 막상 보니까 나쁘지 않은데
이거 다른 사람들도 이렇게 느끼나


위 예시 문장을 그대로 복사하지 말고
결과의 분위기와 자연스러움만 참고한다.


[출력 형식]

서로 확실히 다른 Threads 글 5개를 작성한다.

각 버전 사이에는 반드시 아래처럼
--- 한 줄만 넣는다.

첫 번째 글
---
두 번째 글
---
세 번째 글
---
네 번째 글
---
다섯 번째 글

번호,
"버전 1",
설명,
따옴표,
제목은 붙이지 않는다.

최종 출력에는 게시물 본문 5개와 --- 구분자만 출력한다.
`;
}

// ----------------------------------------------------
// 캡션 생성
// ----------------------------------------------------
async function generateCaption(accountId, { productName, price }) {
  const account = getAccount(accountId);

  const priceText = price
    ? `${Number(price).toLocaleString('ko-KR')}원`
    : '';

  const { currentDate, currentSeason } = getKoreaContext();

  const userMessage = `
현재 날짜: ${currentDate}
현재 계절: ${currentSeason}

상품명: ${productName}
${priceText ? `가격: ${priceText}` : ''}

이 상품을 소재로
위 시스템 규칙에 맞는 Threads 글 5개를 작성해줘.

상품명만 보고 확인할 수 없는 기능,
효능,
사용 경험,
날씨는 임의로 만들어내지 마.
`.trim();

  if (account?.anthropic_api_key) {
    return generateWithAnthropic(
      account.anthropic_api_key,
      userMessage
    );
  }

  if (account?.openai_api_key) {
    return generateWithOpenAI(
      account.openai_api_key,
      userMessage
    );
  }

  throw new Error(
    '이 계정에 Anthropic 또는 OpenAI API 키가 설정되지 않았습니다 (연결 설정에서 입력)'
  );
}

// ----------------------------------------------------
// 계절/날씨 오류 방어 필터
// ----------------------------------------------------
// 시스템 프롬프트(규칙 1)에서 이미 금지했지만, 모델이 가끔 지시를 놓치는 경우가 있어서
// (예: 8월인데 "엄청 추운 아침에 일어났는데... 오버핏 맥코트를 꺼냈지") 생성 후에도 한 번 더 걸러낸다.
// 규칙 1이 금지하는 "확정적인 현재 날씨 단정" 표현만 좁게 잡아서, 정상적인
// "다음 계절 대비" 문구(예: "가을 오면 입을 코트 미리 저장해둠")까지 오탐하지 않게 한다.
const WEATHER_CLAIM_PATTERNS = [
  /너무\s*추워/, /너무\s*더워/, /엄청\s*추운/, /엄청\s*더운/,
  /한파/, /폭염/, /눈이\s*(엄청\s*)?와서/, /비가\s*(엄청\s*)?와서/,
  /추운\s*아침/, /더운\s*아침/, /옷장이\s*고장/,
];

function violatesWeatherClaim(text) {
  return WEATHER_CLAIM_PATTERNS.some((re) => re.test(text));
}

function filterWeatherMismatch(variants) {
  const safe = variants.filter((v) => !violatesWeatherClaim(v));
  if (safe.length) return safe;
  // 5개 다 걸리는 극히 드문 경우엔, 발행이 아예 안 막히도록 원본을 그대로 반환하고 로그만 남긴다
  console.error('[캡션 필터] 생성된 글 전부에서 날씨 단정 표현이 감지됨 — 필터링 없이 원본 반환');
  return variants;
}

// ----------------------------------------------------
// AI 결과 5개 분리
// ----------------------------------------------------
function splitVariants(text) {
  const variants = text
    .split(/\n\s*---\s*\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  const parsed = variants.length ? variants.slice(0, 5) : [text.trim()];
  return filterWeatherMismatch(parsed);
}

// ----------------------------------------------------
// Anthropic
// ----------------------------------------------------
async function generateWithAnthropic(apiKey, userMessage) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      temperature: 0.9,
      system: makeSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const textBlock = res.data?.content?.find(
    (block) => block.type === 'text'
  );

  if (!textBlock?.text) {
    throw new Error('생성 결과를 받지 못했습니다');
  }

  return splitVariants(textBlock.text);
}

// ----------------------------------------------------
// OpenAI
// ----------------------------------------------------
async function generateWithOpenAI(apiKey, userMessage) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      temperature: 0.9,
      messages: [
        {
          role: 'system',
          content: makeSystemPrompt(),
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
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error('생성 결과를 받지 못했습니다');
  }

  return splitVariants(text);
}

// ----------------------------------------------------
// AI가 검색 키워드 후보 자체를 제안 ("완전 자동발행" / "AI 자동완성"에서 사용)
// ----------------------------------------------------
// 이전 버전 aiCaption.js를 통째로 교체하면서 이 함수 자체가 통째로 빠져있었음
// (scheduler.js/server.js는 계속 이 함수를 import해서 호출하고 있었고, 그래서
// "suggestKeywordCandidates is not a function" 에러로 오토파일럿이 계속 실패했던 것)
function makeKeywordSystemPrompt() {
  const { currentDate, currentSeason } = getKoreaContext();
  return `너는 쇼핑 쇼츠/쓰레드 콘텐츠를 위해 쿠팡에서 검색할 상품 키워드를 제안하는 사람이다.

현재 날짜: ${currentDate}
현재 계절: ${currentSeason}

주어진 타겟 독자에 맞춰서, 쿠팡에 검색했을 때
실제로 팔리는 구체적인 상품 카테고리 키워드 5개를 제안해라.

조건:
- 너무 광범위한 단어(예: "여성 옷", "주방용품") 대신
  구체적인 상품군(예: "여름 원피스", "고체 레몬즙", "주방 수납장")으로 제안
- 현재 계절/시기와 어울리는 키워드를 우선 고려 (계절 안 맞는 상품 억지로 넣지 않기)
- 타겟 독자가 실제로 관심 가질 만한 카테고리로
- 매번 똑같은 키워드만 반복하지 않기 위해 다양한 카테고리를 섞을 것

출력 형식: 키워드만 한 줄에 하나씩, 총 5줄. 번호나 설명, 따옴표 붙이지 말 것.`;
}

function parseKeywordList(text) {
  const list = text
    .split('\n')
    .map((line) => line.replace(/^[\d\.\-\*\s]+/, '').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('키워드 후보를 받지 못했습니다');
  return list.slice(0, 5);
}

async function suggestKeywordCandidates(accountId, target) {
  const account = getAccount(accountId);
  const targetText = target && target !== '전체' ? `타겟 독자: ${target}` : '타겟 독자: 전체 연령/성별';
  const userMessage = `${targetText}\n\n위 시스템 규칙에 맞는 검색 키워드 5개를 제안해줘.`;

  let text;
  if (account?.anthropic_api_key) {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        temperature: 0.9,
        system: makeKeywordSystemPrompt(),
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'x-api-key': account.anthropic_api_key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 20000,
      }
    );
    text = res.data?.content?.find((b) => b.type === 'text')?.text;
  } else if (account?.openai_api_key) {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.9,
        messages: [
          { role: 'system', content: makeKeywordSystemPrompt() },
          { role: 'user', content: userMessage },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${account.openai_api_key}`,
          'content-type': 'application/json',
        },
        timeout: 20000,
      }
    );
    text = res.data?.choices?.[0]?.message?.content;
  } else {
    throw new Error('이 계정에 Anthropic 또는 OpenAI API 키가 설정되지 않았습니다 (연결 설정에서 입력)');
  }

  if (!text) throw new Error('키워드 후보를 받지 못했습니다');
  return parseKeywordList(text);
}

module.exports = {
  generateCaption,
  suggestKeywordCandidates,
  // server.js가 import는 하지만 실제로 호출하는 곳은 없는 죽은 import — 에러 방지용으로만 별칭 export
  suggestKeyword: suggestKeywordCandidates,
};
