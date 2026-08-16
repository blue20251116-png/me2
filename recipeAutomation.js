const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const youtubeApi = require('./youtubeApi');
const coupangApi = require('./coupangApi');
const { cropYoutubeThumbnail } = require('./youtubeThumbnailCrop');

const RECIPE_TOPICS = [
  '비빔국수', '김치찌개', '된장찌개', '제육볶음', '닭볶음탕', '떡볶이',
  '계란볶음밥', '김치볶음밥', '오징어볶음', '두부조림', '감자조림',
  '어묵볶음', '진미채볶음', '멸치볶음', '양념계란', '계란장', '콩나물국',
  '순두부찌개', '냉면', '비빔면', '파스타', '짜파게티 응용 레시피',
  '라면 맛있게 끓이는 법', '간장계란밥', '닭갈비', '고추장찌개', '부대찌개',
  '골뱅이무침', '메밀국수', '잔치국수', '비빔밥', '카레', '마파두부',
  '무생채', '오이무침', '깻잎무침', '두부강정', '감자채볶음', '콩나물무침',
];

const POST_STYLES = [
  'secret',
  'family',
  'viral',
  'restaurant',
  'simple',
];

const SECRET_LABELS = [
  '비밀 소스',
  '핵심 재료',
  '맛 잡아주는 재료',
  '이것 하나',
  '포인트 재료',
];

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function callOpenAI(accountId, system, user, maxTokens = 1400) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.82,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
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

  const raw = res.data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('레시피 AI 결과를 받지 못했습니다');
  return JSON.parse(raw);
}

function pickRecipeTopic() {
  return RECIPE_TOPICS[Math.floor(Math.random() * RECIPE_TOPICS.length)];
}

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function findRecipeVideo(accountId, topic, order = 'relevance') {
  const shared = getSystemApiSettings();
  const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const queries = [
    `${topic} 레시피`,
    `${topic} 황금레시피`,
    `${topic} 밥도둑`,
  ];

  for (const q of queries) {
    try {
      const list = await youtubeApi.searchVideos({
        apiKey,
        keyword: q,
        order,
        maxResults: 10,
      });
      if (list.length) return list[0];
    } catch (err) {
      console.log(
        `[Recipe] YouTube 검색 실패 "${q}":`,
        err.response?.data?.error?.message || err.message
      );
    }
  }

  return null;
}

function sanitizeRecipeJson(data, fallbackDish) {
  const ingredients = Array.isArray(data.ingredients)
    ? data.ingredients
        .map((x) => ({
          name: String(x?.name || '').trim(),
          amount: String(x?.amount || '').trim(),
        }))
        .filter((x) => x.name && x.amount)
        .slice(0, 12)
    : [];

  const optional = Array.isArray(data.optional)
    ? data.optional
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const steps = Array.isArray(data.steps)
    ? data.steps
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const dishName = String(data.dishName || fallbackDish || '오늘의 요리').trim();
  const servings = String(data.servings || '1~2인분').trim();
  const secretIngredient = String(data.secretIngredient || '').trim();
  const coupangSearchKeyword = String(
    data.coupangSearchKeyword || secretIngredient || ''
  ).trim();
  const hook = String(data.hook || '').trim();
  const secretReason = String(data.secretReason || '').trim();
  const tastePoint = String(data.tastePoint || '').trim();

  if (!ingredients.length || !steps.length || !secretIngredient || !coupangSearchKeyword) {
    throw new Error('레시피 AI 응답 필수 항목이 부족합니다');
  }

  return {
    dishName,
    servings,
    ingredients,
    optional,
    steps,
    secretIngredient,
    coupangSearchKeyword,
    hook,
    secretReason,
    tastePoint,
  };
}

async function generateRecipe(accountId, topic, video) {
  const system = `너는 한국 Threads용 레시피 콘텐츠를 만드는 요리 에디터다.
반드시 JSON만 출력한다.

목표:
- 본문은 3~6줄 정도의 짧은 생활형 후킹으로 만든다.
- 첫 댓글에는 실제로 따라 할 수 있을 정도로 자세한 계량과 순서를 제공한다.
- 레시피 안에서 쿠팡 검색에 자연스럽게 연결할 수 있는 비밀 소스/핵심 재료 하나를 정한다.

문체:
- 사람이 직접 올린 것처럼 짧고 자연스러운 반말.
- 지나치게 매끈한 광고문구 금지.
- "강추", "필수템", "구매하세요", "인생템" 금지.
- 음슴체 금지.
- ㅋㅋ는 필요할 때 0~1회.

정확성:
- 영상 제목/설명에 실제 재료나 계량이 있으면 우선 참고한다.
- 부족한 부분은 일반적인 레시피 기준으로 보완할 수 있다.
- 영상에 없는 내용을 영상 제작자가 말했다고 주장하지 않는다.
- 특정 영상 제작자/유명인이 쿠팡 상품을 사용했다고 지어내지 않는다.
- "맘카페에서 난리", "식당에서 1000개 팔았다", "이모가 알려줬다" 같은 출처/판매량/가족 경험은 실제 근거가 없으면 쓰지 않는다.
- 대신 "요즘 자꾸 보이길래", "레시피 찾아보다가", "이 조합 괜찮아 보여서"처럼 사실을 지어내지 않는 표현을 쓴다.
- 건강효과/치료효과를 주장하지 않는다.

레시피 규칙:
- 계량은 1스푼, 1/2스푼, 100ml, 1팩처럼 한국식으로 명확히 쓴다.
- 핵심 재료 최대 12개.
- 조리순서 최대 5단계.
- secretIngredient는 소스, 양념, 육수, 장류, 오일, 향신료처럼 쿠팡에서 검색하기 좋은 재료를 우선한다.
- coupangSearchKeyword는 브랜드명을 억지로 만들지 말고 일반 상품 키워드로 쓴다.

JSON 형식:
{
  "dishName":"요리명",
  "servings":"1인분",
  "hook":"본문에서 사용할 짧은 핵심 문장",
  "tastePoint":"이 요리의 맛 포인트를 짧게 설명",
  "ingredients":[{"name":"고추장","amount":"2스푼"}],
  "optional":["오이","계란"],
  "steps":["양념을 섞는다","면을 삶아 찬물에 헹군다"],
  "secretIngredient":"냉면육수",
  "secretReason":"양념 농도와 감칠맛을 잡기 편해서 추가하는 재료",
  "coupangSearchKeyword":"냉면육수"
}`;

  const user = `주제: ${topic}

참고 YouTube 영상 제목:
${video?.title || '없음'}

참고 YouTube 영상 설명:
${video?.description || '없음'}

위 정보를 참고해 실제 따라 하기 좋은 레시피 JSON을 만들어줘.`;

  const data = await callOpenAI(accountId, system, user, 1600);
  return sanitizeRecipeJson(data, topic);
}

function buildRecipePostText(recipe) {
  const style = pickOne(POST_STYLES);
  const hook = recipe.hook || `${recipe.dishName} 이 조합 생각보다 괜찮더라`;

  const variants = {
    secret: `${hook}\n\n${recipe.dishName} 별거 안 들어가는데\n마지막에 이것 하나 넣으니까 맛이 확 달라짐ㅋㅋ\n\n레시피랑 내가 넣은 비밀 재료는 댓글에 적어둘게.`,

    family: `${recipe.dishName} 레시피 찾아보다가\n이 비율이 제일 따라 하기 쉽더라.\n\n재료 몇 개만 맞추면 생각보다 간단함.\n${recipe.servings} 기준은 댓글에 적어둘게.`,

    viral: `${hook}\n\n요즘 이런 레시피 자꾸 보여서 나도 정리해봄.\n핵심은 양념 비율이랑 마지막 재료 하나더라.\n\n정확한 계량은 댓글에 적어둘게.`,

    restaurant: `${recipe.dishName} 집에서 만들 때\n왜 밖에서 먹는 맛이 안 나나 했는데\n양념보다 마지막 한 가지가 포인트였음.\n\n${recipe.servings} 레시피 댓글에 남겨둘게.`,

    simple: `${hook}\n\n복잡한 레시피 싫어서\n딱 따라 하기 쉽게 계량 다시 정리했어.\n비밀 재료까지 댓글에 같이 적어둘게.`,
  };

  return variants[style];
}

function buildRecipeCommentText(recipe) {
  const label = pickOne(SECRET_LABELS);
  const main = recipe.ingredients
    .map((x) => `${x.name} ${x.amount}`)
    .join(', ');

  const optional = recipe.optional.length
    ? `\n\n✔ 있으면 좋은 재료\n${recipe.optional.join(', ')}`
    : '';

  const steps = recipe.steps
    .map((x, i) => `${i + 1}. ${x}`)
    .join('\n');

  const reason = recipe.secretReason
    ? `\n${recipe.secretReason}`
    : '';

  let text = `✅ ${recipe.dishName} (${recipe.servings})\n\n🛒 재료\n${main}${optional}\n\n♦ ${label}\n${recipe.secretIngredient}${reason}\n\n🥢 만드는 법\n${steps}\n\n${label}은 아래 링크에서 확인하면 돼👇`;

  // 고지문+URL이 뒤에 붙을 여유를 남긴다.
  if (text.length > 390) {
    const compactSteps = recipe.steps
      .slice(0, 4)
      .map((x, i) => `${i + 1}. ${x}`)
      .join('\n');

    text = `✅ ${recipe.dishName} (${recipe.servings})\n\n🛒 재료\n${main}\n\n♦ ${label}\n${recipe.secretIngredient}${reason}\n\n🥢 레시피\n${compactSteps}\n\n${label}은 아래 링크👇`;
  }

  if (text.length > 430) {
    text = `${text.slice(0, 420).trimEnd()}…\n\n${label}: ${recipe.secretIngredient}👇`;
  }

  return text;
}

async function chooseCoupangProduct(accountId, searchKeyword) {
  const products = await coupangApi.searchProducts(accountId, searchKeyword, 8);
  if (!products.length) {
    throw new Error(`쿠팡에서 "${searchKeyword}" 관련 상품을 찾지 못했습니다`);
  }

  // 지나치게 랜덤하지 않게 로켓 상품 우선, 없으면 첫 결과.
  return products.find((p) => p.isRocket) || products[0];
}

async function buildRecipeAutopilot({ account, target }) {
  const topic = pickRecipeTopic();
  console.log(`[Recipe] 레시피형 시작 — 주제="${topic}"`);

  const video = await findRecipeVideo(
    account.id,
    topic,
    account.autopilot_youtube_order || 'relevance'
  );

  const recipe = await generateRecipe(account.id, topic, video);
  const product = await chooseCoupangProduct(
    account.id,
    recipe.coupangSearchKeyword
  );

  let imageUrl = product.image || null;
  let extraImageUrl = null;
  let imageSourceLabel = imageUrl ? '비밀소스 상품컷 1장' : '없음';

  if (video?.thumbnail) {
    let thumbnail = video.thumbnail;

    try {
      thumbnail = await cropYoutubeThumbnail({
        account,
        thumbnailUrl: video.thumbnail,
        videoId: video.id,
      });
      console.log('[Recipe] 레시피 썸네일 중앙 크롭 완료');
    } catch (err) {
      console.log(
        '[Recipe] 레시피 썸네일 크롭 실패 — 원본 사용:',
        err.message
      );
    }

    imageUrl = thumbnail;
    extraImageUrl = product.image || null;
    imageSourceLabel = extraImageUrl
      ? '레시피 썸네일 + 비밀소스 상품컷'
      : '레시피 썸네일 1장';
  }

  return {
    text: buildRecipePostText(recipe),
    recipeCommentText: buildRecipeCommentText(recipe),
    link: product.url,
    imageUrl,
    extraImageUrl,
    imageSourceLabel,
    product,
    keyword: recipe.coupangSearchKeyword,
    trendNote: `레시피형 · ${recipe.dishName}`,
    recipe,
    youtubeSource: video,
    target,
  };
}

module.exports = {
  buildRecipeAutopilot,
};
