const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const youtubeApi = require('./youtubeApi');
const coupangApi = require('./coupangApi');
const { cropYoutubeThumbnail } = require('./youtubeThumbnailCrop');

const RECIPE_TOPICS = [
  '비빔국수', '김치찌개', '된장찌개', '제육볶음', '닭볶음탕', '떡볶이',
  '계란볶음밥', '김치볶음밥', '오징어볶음', '두부조림', '감자조림',
  '어묵볶음', '진미채볶음', '콩나물국', '순두부찌개', '냉면', '비빔면',
  '파스타', '짜파게티 응용 레시피', '라면 맛있게 끓이는 법', '간장계란밥',
  '닭갈비', '고추장찌개', '부대찌개', '골뱅이무침', '메밀국수', '잔치국수',
  '비빔밥', '카레', '마파두부',
];

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function callOpenAI(accountId, system, user, maxTokens = 1200) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.75,
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

async function findRecipeVideo(accountId, topic, order = 'relevance') {
  const shared = getSystemApiSettings();
  const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const queries = [`${topic} 레시피`, `${topic} 황금레시피`, `${topic} 1인분`];
  for (const q of queries) {
    try {
      const list = await youtubeApi.searchVideos({ apiKey, keyword: q, order, maxResults: 10 });
      if (list.length) return list[0];
    } catch (err) {
      console.log(`[Recipe] YouTube 검색 실패 "${q}":`, err.response?.data?.error?.message || err.message);
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
        .slice(0, 10)
    : [];

  const optional = Array.isArray(data.optional)
    ? data.optional.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5)
    : [];

  const steps = Array.isArray(data.steps)
    ? data.steps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
    : [];

  const dishName = String(data.dishName || fallbackDish || '오늘의 요리').trim();
  const servings = String(data.servings || '1~2인분').trim();
  const secretIngredient = String(data.secretIngredient || '').trim();
  const coupangSearchKeyword = String(data.coupangSearchKeyword || secretIngredient || '').trim();
  const hook = String(data.hook || '').trim();
  const secretReason = String(data.secretReason || '').trim();

  if (!ingredients.length || !steps.length || !secretIngredient || !coupangSearchKeyword) {
    throw new Error('레시피 AI 응답 필수 항목이 부족합니다');
  }

  return {
    dishName, servings, ingredients, optional, steps,
    secretIngredient, coupangSearchKeyword, hook, secretReason,
  };
}

async function generateRecipe(accountId, topic, video) {
  const system = `너는 한국 Threads용 레시피 콘텐츠를 만드는 요리 에디터다.
반드시 JSON만 출력한다.

목표:
- 게시물 본문은 짧고 궁금증이 생기게 만든다.
- 첫 댓글에는 실제로 따라 할 수 있을 정도로 자세한 계량 레시피를 제공한다.
- 레시피 안에서 쿠팡 검색에 자연스럽게 연결할 수 있는 "비밀 소스/비밀 재료" 하나를 정한다.

정확성 규칙:
- 영상 제목/설명에 실제 재료나 계량이 있으면 우선 참고한다.
- 영상에 없는 계량을 보완할 수는 있지만 "영상 그대로의 레시피"라고 주장하지 않는다.
- 특정 영상 제작자나 유명인이 그 쿠팡 상품을 사용했다고 지어내지 않는다.
- 비밀 재료는 소스, 양념, 육수, 장류, 오일, 향신료처럼 쿠팡 검색하기 좋은 식재료를 우선한다.
- 건강효과/효능을 주장하지 않는다.
- 음슴체 금지.
- 계량은 "1스푼, 1/2스푼, 100ml, 1팩"처럼 짧고 명확하게 쓴다.
- 핵심 재료는 최대 10개, 조리순서는 최대 4단계로 간결하게 쓴다.

JSON 형식:
{
  "dishName":"요리명",
  "servings":"1인분",
  "hook":"본문에 쓸 짧은 후킹 핵심",
  "ingredients":[{"name":"고추장","amount":"2스푼"}],
  "optional":["오이","계란"],
  "steps":["양념을 섞는다","면을 삶아 찬물에 헹군다"],
  "secretIngredient":"냉면육수",
  "secretReason":"양념 농도와 맛을 잡기 편해서 내가 추가하는 재료",
  "coupangSearchKeyword":"냉면육수"
}`;

  const user = `주제: ${topic}

참고 YouTube 영상 제목:
${video?.title || '없음'}

참고 YouTube 영상 설명:
${video?.description || '없음'}

위 정보를 참고해 실제 따라 하기 좋은 레시피 JSON을 만들어줘.`;

  const data = await callOpenAI(accountId, system, user, 1500);
  return sanitizeRecipeJson(data, topic);
}

function buildRecipePostText(recipe) {
  const hook = recipe.hook || `${recipe.dishName} 이 조합으로 하면 생각보다 간단하더라`;
  return `${hook}\n\n재료는 별거 없는데 비율이 진짜 중요해.\n나는 마지막에 비밀 소스 하나 더 넣는 편인데 맛 잡기가 훨씬 편했어.\n\n${recipe.servings} 기준 레시피랑 비밀 소스는 댓글에 적어둘게.`;
}

function buildRecipeCommentText(recipe) {
  const title = `🌿 ${recipe.dishName} (${recipe.servings})`;
  const ingredientLines = recipe.ingredients.map((x) => `▪ ${x.name} ${x.amount}`).join('\n');
  const optionalLine = recipe.optional.length ? `\n✔ 취향껏 ${recipe.optional.join(', ')}` : '';
  const stepLine = recipe.steps.length
    ? `\n\n✔ 순서: ${recipe.steps.map((x, i) => `${i + 1}) ${x}`).join(' → ')}`
    : '';
  const secretLine = `\n\n비밀 소스는 ${recipe.secretIngredient}ㅋㅋ\n이 재료는 아래 링크에서 확인하면 돼👇`;

  // Threads 댓글은 고지문+링크까지 함께 붙으므로 레시피 본문은 여유 있게 제한한다.
  // 길면 조리순서부터 줄이고, 그래도 길면 선택 고명을 줄인다.
  let text = `${title}\n\n${ingredientLines}${optionalLine}${stepLine}${secretLine}`;
  if (text.length > 340) {
    text = `${title}\n\n${ingredientLines}${optionalLine}${secretLine}`;
  }
  if (text.length > 340) {
    text = `${title}\n\n${ingredientLines}${secretLine}`;
  }
  if (text.length > 340) {
    text = `${text.slice(0, 330).trimEnd()}…\n비밀 소스는 ${recipe.secretIngredient}👇`;
  }
  return text;
}

async function chooseCoupangProduct(accountId, searchKeyword) {
  const products = await coupangApi.searchProducts(accountId, searchKeyword, 8);
  if (!products.length) throw new Error(`쿠팡에서 "${searchKeyword}" 관련 상품을 찾지 못했습니다`);
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
  const product = await chooseCoupangProduct(account.id, recipe.coupangSearchKeyword);

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
      console.log('[Recipe] 레시피 썸네일 중앙 세로 크롭 완료');
    } catch (err) {
      console.log('[Recipe] 레시피 썸네일 크롭 실패 — 원본 사용:', err.message);
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

module.exports = { buildRecipeAutopilot };
