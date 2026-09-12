const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const { voiceGuide } = require('./threadsVoicePolicy');
const { pickPersona } = require('./threadsPersonas');

// SaaS 전환 이후 OpenAI는 회원 개별 키가 아니라 운영자가 등록한 공용 키(system_api_settings)를
// 우선 쓰기로 했는데(아이Image.js와 동일 원칙), 이 파일(aiCaption.js)만 공용키 조회 없이
// account 개별 키만 보고 있어서 "API 키가 설정되지 않았습니다" 오류가 났었다 — 여기서 통일한다.
// Anthropic 키는 공용화 대상이 아니라서(system_api_settings에 없음) 계정 개별 키만 확인한다.
function resolveModelKeys(account) {
  const shared = getSystemApiSettings();
  return {
    anthropicKey: account?.anthropic_api_key || null,
    openaiKey: shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null,
  };
}

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
function makeSystemPrompt(personaBlock) {
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


${voiceGuide(personaBlock)}

[이 도구 전용 추가 규칙 — 원문 소재가 없는 상품명/가격 기반 캡션 도구다]
- 원문 소재가 없으므로 제3자 발견담을 지어내지 않는다. "친구가 추천했다", "남편이 사줬다", "회사 동료가 쓴다", "한 달 동안 썼다" 같은 구체적인 사실을 임의로 만들지 말고, "써보니/궁금해서/찜해둠" 같은 1인칭 느낌으로 쓴다.
- 현재 날짜와 계절을 반드시 고려한다. 계절과 안 맞는 날씨·상황을 실제처럼 지어내지 않는다 (예: 여름인데 "너무 추워서 패딩 입었다", 겨울인데 "너무 더워서 선풍기 꺼냈다"). "오늘 비가 와서", "폭염이라서"처럼 확인되지 않은 구체적 날씨도 단정하지 않는다. 상품이 계절과 무관하면 계절 얘기를 억지로 넣지 않는다.
- 상품 계절과 현재 계절이 안 맞으면 지금 쓰는 것처럼 지어내지 말고, 미리 준비/다음 시즌 대비/우연히 발견/찜해둠/가격 보고 미리 구매 같은 자연스러운 상황으로 푼다.
- 제품 장점은 한 게시물에 최대 1~2개까지만 자연스럽게 녹이고, 기능을 연속 나열하지 않는다.
- 5개 버전은 오프닝 스타일(공감형/질문형/혼잣말형/발견형/충동구매형/고민형/짧은 썰형/반전형/감탄형), 구조, 길이(2~3줄/4~5줄/5~7줄)를 서로 다르게 섞는다. "상황→불편→제품 등장→장점→만족→추천" 같은 같은 구조를 반복하지 않는다.
- 상품명/브랜드명을 본문에서 반복하지 않는다. "이거", "이런 거"처럼 자연스럽게 지칭하되, 상품 종류조차 알 수 없게 지나치게 숨기지는 않는다.
- 다음은 본문에 넣지 않는다: 링크, 해시태그, 광고 표시 문구, "구매는 댓글"/"프로필 링크"/"궁금하면 댓글" 같은 유도 문구, 이모지 남발 — 이런 요소는 시스템에서 별도로 처리한다.
- 가격처럼 실제로 제공된 정보는 최소 1~2개 버전에서 자연스럽게 언급할 수 있다("이 가격에 이 정도면"). 제공되지 않은 리뷰 수·평점·판매량은 지어내지 않는다.
- 5개 중 최소 2~3개는 의견이 갈릴 만한 가벼운 질문이나 되묻는 한 줄로 답글을 자연스럽게 유도하는 마무리를 섞는다. 나머지는 담백하게 끝내도 된다 (전부 유도형이면 부자연스러움).


[상품별 판단 규칙]

카테고리마다 실제 그 카테고리를 사는 사람이 쓸 법한 표현과 관심사가 다르다.
아래 카테고리에 없는 다른 표현(다른 카테고리의 문구를 그대로 가져다 쓰는 것)은 피한다.

여성패션 / 남성패션이라면
핏, 색감, 소재감, 코디 고민, 계절 준비, "이거랑 뭐 매치하지" 같은 스타일링 고민으로 접근한다.
"신기해서", "발견해서"보다는 "고민하다가", "찜해두다가" 쪽이 자연스럽다.

뷰티라면
피부 타입/톤, 발림성, 향, 지속력, 기존에 쓰던 제품과의 비교 궁금증으로 접근한다.
효능을 단정("피부가 좋아졌다")하지 말고 "써보고 싶다/궁금하다" 수준에서 멈춘다.

출산/유아동이라면
아이 월령/개월수, 안전성에 대한 조심스러운 관심, 다른 부모들 후기 궁금증으로 접근한다.
과장된 효과나 확정적 안전 보장 표현은 쓰지 않는다.

식품이라면
"생긴 게 신기해서", "여름에 써도 되나" 같은 가전/생활용품식 문구는 쓰지 않는다.
대신 뭘 만들어 먹을지/어떻게 곁들일지 고민, 냉장고 재고 채우기, 베이킹·요리 재료로서의
관심, 맛에 대한 궁금증, 레시피 발견처럼 "먹는 것"다운 각도로 접근한다.
확인되지 않은 건강 효능은 만들어내지 않는다.

주방용품이라면
설거지/보관/조리 과정에서의 사소한 불편, 수납 공간, 세척 편의성처럼
매일 부엌에서 부딪히는 디테일로 접근한다.

생활용품이라면
청소/정리/수납 등 일상의 사소한 불편이나 발견에서 시작할 수 있다.

홈인테리어라면
집 전체 분위기, 톤 앤 매너, "이거 하나로 느낌이 달라지나" 하는 공간 감성으로 접근한다.
스펙보다는 "어울릴지" 고민 쪽이 자연스럽다.

가전디지털이라면
스펙을 임의로 만들어내지 않는다. 기존에 쓰던 제품의 불편(소음, 크기, 속도 등)과
비교하는 식의 실사용 관점 고민으로 접근한다.

스포츠/레저라면
운동 루틴, 다음 계획(등산/캠핑/러닝 일정), 장비 욕심처럼 활동 자체에 대한
기대감이나 준비 과정으로 접근한다.

자동차용품이라면
차량 관리 루틴, 세차/정비 타이밍, 운전 중 불편했던 디테일로 접근한다.

헬스/건강식품이라면
질병 치료, 체중 감량 보장, 성기능 개선 등 확정적인 효과를 절대 주장하지 않는다.
"챙겨 먹어볼까" 정도의 가벼운 관심 수준에서 멈춘다.

반려동물용품이라면
반려동물의 성향/크기/나이대에 대한 언급, 집사 입장에서의 고민(호불호, 안전성 걱정)으로 접근한다.
반려동물이 실제로 좋아했다는 식의 지어낸 반응은 쓰지 않는다.

전자제품이라면
제공되지 않은 스펙을 임의로 만들어내지 않는다.

계절상품이라면
현재 계절과의 관계를 가장 먼저 확인한다 (규칙 1, 2 참고).
계절과 무관한 카테고리(위 목록 대부분)는 계절 언급 자체를 굳이 넣지 않는다.


바로 아래 이어지는 문체 참고 예시는 톤·자연스러움 참고용 일반 예시일 뿐이다. 위에서 배정된
페르소나(예: 궁금증 유발형의 "정체를 초반에 드러내지 않는다", 주부 후기형의 "먹이는 사람 반응으로
시작한다" 같은 구조 지시)와 그 예시의 스타일이 다르면, 반드시 위 페르소나 지시를 따르고 아래 예시는
무시한다 — 아래 예시는 전부 첫 줄에서 상황/소재를 바로 드러내는 스타일이라, 정체를 숨기고 시작해야
하는 페르소나와는 구조적으로 맞지 않는다.

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

<글 1 내용>
---
<글 2 내용>
---
<글 3 내용>
---
<글 4 내용>
---
<글 5 내용>

위 <글 1 내용> 같은 꺾쇠괄호 표시는 실제 게시물 본문이 들어갈 자리라는 표시일 뿐,
절대 그대로 출력하거나 "첫 번째 글", "두 번째 글" 같은 문구로 바꿔서 넣지 않는다.
번호,
"버전 1",
"첫 번째 글" 같은 순번 표현,
설명,
따옴표,
제목은 절대 붙이지 않는다 — 각 글은 실제 게시물 본문 그 자체로 바로 시작해야 한다.

최종 출력에는 게시물 본문 5개와 --- 구분자만 출력한다.
`;
}

// ----------------------------------------------------
// 캡션 생성
// ----------------------------------------------------
async function generateCaption(accountId, { productName, price, youtubeSource }) {
  const account = getAccount(accountId);

  const priceText = price
    ? `${Number(price).toLocaleString('ko-KR')}원`
    : '';

  const { currentDate, currentSeason } = getKoreaContext();

  // youtubeSource가 있을 때만 참고 소재로 프롬프트에 추가한다 — 없으면 기존 프롬프트와 100% 동일하게 동작.
  // 영상 제목/설명은 "아이디어 참고자료"로만 쓰고, 그대로 베끼거나 없는 사실을 지어내지 않도록
  // 명확히 제한한다.
  const youtubeContext = youtubeSource && youtubeSource.title
    ? `

참고용 콘텐츠 소재 (YouTube 영상 — 아이디어 참고용일 뿐, 절대 그대로 베끼지 말 것):
영상 제목: ${youtubeSource.title}
${youtubeSource.description ? `영상 설명: ${String(youtubeSource.description).slice(0, 300)}` : ''}

이 소재를 사용할 때 반드시 지킬 것:
- 이 영상을 만든 사람이나 사용자가 실제로 이 제품을 사용했다고 단정하지 않는다
- 사용자 본인이 이 제품을 직접 사용해봤다고 단정하지 않는다
- 영상 제목/설명에 없는 사실을 지어내지 않는다
- 영상 속 문장을 그대로 복사하지 않고, 영상에서 보이는 주제나 상황만 참고해서 새로운 글을 쓴다
- 영상에 연예인/유명인이 등장하더라도, 그 사람이 이 상품을 추천했다거나 매일 사용한다고
  임의로 지어내지 않는다 — 확인 가능한 것은 "이런 상황/장면이 나온다" 정도까지만이다
- 상품 설명부터 바로 시작하는 광고문 형태로 쓰지 않는다`
    : '';

  const userMessage = `
현재 날짜: ${currentDate}
현재 계절: ${currentSeason}

상품명: ${productName}
${priceText ? `가격: ${priceText}` : ''}${youtubeContext}

이 상품을 소재로
위 시스템 규칙에 맞는 Threads 글 5개를 작성해줘.

상품명만 보고 확인할 수 없는 기능,
효능,
사용 경험,
날씨는 임의로 만들어내지 마.
`.trim();

  const { anthropicKey, openaiKey } = resolveModelKeys(account);
  const persona = pickPersona({ mode: 'product', text: `${productName || ''} ${youtubeSource?.title || ''}` });
  console.log(`[Caption] persona picked="${persona.name}"(${persona.id}) productName="${productName}"`);

  if (anthropicKey) {
    return generateWithAnthropic(
      anthropicKey,
      userMessage,
      persona.block
    );
  }

  if (openaiKey) {
    return generateWithOpenAI(
      openaiKey,
      userMessage,
      persona.block
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

// 모델이 "첫 번째 글" 같은 순번 라벨을 실제 본문 첫 줄로 착각해서 넣는 경우가 있어서
// (예: 본문이 "세 번째 글\n아기 기저귀는..."처럼 시작) 맨 앞줄에 이 패턴이 단독으로 있으면 제거한다
const LEADING_ORDINAL_LABEL = /^(첫|두|세|네|다섯)\s*번째\s*글\s*\n+/;

function stripLeadingOrdinalLabel(text) {
  return text.replace(LEADING_ORDINAL_LABEL, '');
}

// ----------------------------------------------------
// AI 결과 5개 분리
// ----------------------------------------------------
function splitVariants(text) {
  const variants = text
    .split(/\n\s*---\s*\n/)
    .map((v) => stripLeadingOrdinalLabel(v.trim()).trim())
    .filter(Boolean);

  const parsed = variants.length ? variants.slice(0, 5) : [stripLeadingOrdinalLabel(text.trim()).trim()];
  return filterWeatherMismatch(parsed);
}

// ----------------------------------------------------
// Anthropic
// ----------------------------------------------------
async function generateWithAnthropic(apiKey, userMessage, personaBlock) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      temperature: 0.9,
      system: makeSystemPrompt(personaBlock),
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
async function generateWithOpenAI(apiKey, userMessage, personaBlock) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      temperature: 0.9,
      messages: [
        {
          role: 'system',
          content: makeSystemPrompt(personaBlock),
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
  const { anthropicKey, openaiKey } = resolveModelKeys(account);
  const targetText = target && target !== '전체' ? `타겟 독자: ${target}` : '타겟 독자: 전체 연령/성별';
  const userMessage = `${targetText}\n\n위 시스템 규칙에 맞는 검색 키워드 5개를 제안해줘.`;

  let text;
  if (anthropicKey) {
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
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 20000,
      }
    );
    text = res.data?.content?.find((b) => b.type === 'text')?.text;
  } else if (openaiKey) {
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
          Authorization: `Bearer ${openaiKey}`,
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

// ----------------------------------------------------
// 완전자동화(오토파일럿)의 YouTube 콘텐츠 소싱에서 사용 —
// 쿠팡 상품명에서 브랜드/모델/규격을 걷어낸 짧은 YouTube 검색어 1~3개를 제안
// ----------------------------------------------------
function makeYoutubeKeywordSystemPrompt() {
  return `너는 쇼핑 콘텐츠 제작을 위해 YouTube에서 검색할 핵심 키워드를 뽑는 사람이다.

주어진 쿠팡 상품명에서 브랜드명, 모델명, 규격(숫자/W/mm 등), 판매 문구를 제거하고
사람들이 실제로 YouTube에서 검색할 법한 짧은 키워드 1~3개를 제안해라.

조건:
- 브랜드명/제품 고유명은 제외
- 영어 표현을 하나 정도 섞어도 좋음 (해외 콘텐츠도 걸리도록)
- 키워드는 2~4단어 이내로 짧게

출력 형식: 키워드만 한 줄에 하나씩, 최대 3줄. 번호나 설명, 따옴표 붙이지 말 것.`;
}

async function suggestYoutubeSearchKeywords(accountId, productName) {
  const account = getAccount(accountId);
  const { anthropicKey, openaiKey } = resolveModelKeys(account);
  const userMessage = `쿠팡 상품명: ${productName}\n\n위 규칙에 맞는 YouTube 검색 키워드를 만들어줘.`;

  let text;
  if (anthropicKey) {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        temperature: 0.7,
        system: makeYoutubeKeywordSystemPrompt(),
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 15000,
      }
    );
    text = res.data?.content?.find((b) => b.type === 'text')?.text;
  } else if (openaiKey) {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 150,
        temperature: 0.7,
        messages: [
          { role: 'system', content: makeYoutubeKeywordSystemPrompt() },
          { role: 'user', content: userMessage },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'content-type': 'application/json',
        },
        timeout: 15000,
      }
    );
    text = res.data?.choices?.[0]?.message?.content;
  } else {
    throw new Error('이 계정에 Anthropic 또는 OpenAI API 키가 설정되지 않았습니다');
  }

  if (!text) throw new Error('키워드 후보를 받지 못했습니다');
  return text
    .split('\n')
    .map((line) => line.replace(/^[\d\.\-\*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

module.exports = {
  generateCaption,
  suggestKeywordCandidates,
  suggestYoutubeSearchKeywords,
  resolveModelKeys,
  // server.js가 import는 하지만 실제로 호출하는 곳은 없는 죽은 import — 에러 방지용으로만 별칭 export
  suggestKeyword: suggestKeywordCandidates,
  makeSystemPrompt,
};
