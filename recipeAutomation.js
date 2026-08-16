const axios = require('axios');
const { getAccount, getSystemApiSettings, getPexelsApiKey } = require('./db');
const youtubeApi = require('./youtubeApi');
const coupangApi = require('./coupangApi');
const { searchFoodPhotos } = require('./pexelsApi');

const RECIPE_TOPICS = [
  '비빔국수', '김치찌개', '된장찌개', '제육볶음', '닭볶음탕', '떡볶이',
  '계란볶음밥', '김치볶음밥', '오징어볶음', '두부조림', '감자조림',
  '어묵볶음', '진미채볶음', '멸치볶음', '양념계란', '계란장', '콩나물국',
  '순두부찌개', '냉면', '비빔면', '파스타', '짜파게티 응용 레시피',
  '라면 맛있게 끓이는 법', '간장계란밥', '닭갈비', '고추장찌개', '부대찌개',
  '골뱅이무침', '메밀국수', '잔치국수', '비빔밥', '카레', '마파두부',
  '무생채', '오이무침', '깻잎무침', '두부강정', '감자채볶음', '콩나물무침',
];

const POST_STYLES = ['problem', 'difference', 'simple', 'ratio', 'ingredient', 'leftover'];
const SECRET_LABELS = [
  '맛 잡아주는 재료',
  '포인트 재료',
  '양념에서 중요한 재료',
  '국물 맛 잡는 재료',
  '한 끗 차이 나는 재료',
];
const LINK_LEADS = [
  '맛 잡아주는 재료 링크는 아래에👇',
  '포인트 재료 링크는 아래에👇',
  '재료 찾기 쉽게 링크는 아래에👇',
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
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
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
  const queries = [`${topic} 레시피`, `${topic} 황금레시피`, `${topic} 밥도둑`];
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

async function findRecipePhotos(recipe, topic) {
  const apiKey = getPexelsApiKey() || process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.log('[Recipe] Pexels API Key 없음 — 관리자 페이지에서 키를 저장해주세요');
    return [];
  }
  const queries = [recipe.dishName, topic, `${recipe.dishName} korean food`];
  for (const query of queries) {
    try {
      const photos = await searchFoodPhotos({ apiKey, query, count: 2 });
      if (photos.length) {
        console.log(`[Recipe] Pexels 요리사진 ${photos.length}장 선택 — query="${query}"`);
        return photos.slice(0, 2);
      }
    } catch (err) {
      console.log(`[Recipe] Pexels 이미지 검색 실패 "${query}":`, err.response?.data?.error || err.message);
    }
  }
  return [];
}

function sanitizeRecipeJson(data, fallbackDish) {
  const ingredients = Array.isArray(data.ingredients)
    ? data.ingredients.map((x) => ({ name: String(x?.name || '').trim(), amount: String(x?.amount || '').trim() }))
        .filter((x) => x.name && x.amount).slice(0, 12)
    : [];
  const optional = Array.isArray(data.optional)
    ? data.optional.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const dishName = String(data.dishName || fallbackDish || '오늘의 요리').trim();
  const servings = String(data.servings || '1~2인분').trim();
  const secretIngredient = String(data.secretIngredient || '').trim();
  const coupangSearchKeyword = String(data.coupangSearchKeyword || secretIngredient || '').trim();
  const hook = String(data.hook || '').trim();
  const secretReason = String(data.secretReason || '').trim();
  const tastePoint = String(data.tastePoint || '').trim();

  if (!ingredients.length || !secretIngredient || !coupangSearchKeyword) {
    throw new Error('레시피 AI 응답 필수 항목이 부족합니다');
  }
  return { dishName, servings, ingredients, optional, secretIngredient, coupangSearchKeyword, hook, secretReason, tastePoint };
}

async function generateRecipe(accountId, topic, video) {
  const system = `너는 한국 Threads용 레시피 콘텐츠를 만드는 요리 에디터다.
반드시 JSON만 출력한다.

목표:
- 본문은 3~6줄 정도의 짧은 생활형 후킹으로 만든다.
- 첫 댓글은 조리법 설명이 아니라 저장하기 좋은 재료표와 정확한 계량 중심으로 만든다.
- 레시피 안에서 쿠팡 검색에 자연스럽게 연결할 수 있는 핵심 재료 하나를 정한다.
- 핵심 재료는 실제 레시피에 필요한 재료여야 하며 상품을 팔기 위해 레시피를 왜곡하지 않는다.

문체:
- 사람이 직접 올린 것처럼 짧고 자연스러운 반말.
- 음슴체 금지.
- 광고 카피처럼 시작하지 않는다.
- 가족, 지인, 전문가에게 들었다는 설정이나 직접 먹어봤다는 경험을 근거 없이 만들지 않는다.
- 특정 영상 제작자나 유명인이 상품을 사용했다고 지어내지 않는다.

레시피 규칙:
- 계량은 1스푼, 1/2스푼, 100ml, 1팩처럼 명확히 쓴다.
- 재료는 핵심 위주 최대 12개.
- 조리순서는 생성하지 않는다.
- secretIngredient는 소스, 양념, 육수, 장류, 오일, 향신료, 손질식품처럼 쿠팡에서 검색하기 좋은 실제 필요 재료를 우선한다.
- 소금, 설탕, 물, 후추 같은 기본재료는 secretIngredient로 가급적 선택하지 않는다.
- coupangSearchKeyword는 쿠팡에서 검색할 법한 1~3단어 상품 키워드로 쓴다.

JSON 형식:
{
  "dishName":"요리명",
  "servings":"1인분",
  "hook":"짧고 자연스러운 한 문장",
  "tastePoint":"맛 포인트",
  "ingredients":[{"name":"고추장","amount":"2스푼"}],
  "optional":["오이","계란"],
  "secretIngredient":"냉면육수",
  "secretReason":"양념 농도와 감칠맛을 잡기 편한 재료",
  "coupangSearchKeyword":"냉면육수"
}`;

  const user = `주제: ${topic}\n\n참고 YouTube 영상 제목:\n${video?.title || '없음'}\n\n참고 YouTube 영상 설명:\n${video?.description || '없음'}\n\n위 정보를 참고해 실제 레시피에 맞는 재료와 계량 중심 JSON을 만들어줘. 조리순서는 쓰지 마. 핵심 재료는 레시피에 실제 필요한 범위에서 정해줘.`;
  const data = await callOpenAI(accountId, system, user, 1400);
  return sanitizeRecipeJson(data, topic);
}

function buildRecipePostText(recipe) {
  const style = pickOne(POST_STYLES);
  const hook = recipe.hook || `${recipe.dishName}은 양념 비율 하나만 달라도 맛이 꽤 달라지더라`;
  const variants = {
    problem: `${recipe.dishName} 만들 때\n똑같이 재료 넣는데도 맛이 매번 조금씩 다르잖아.\n\n양념 비율만 정리해두면 훨씬 편해.\n${recipe.servings} 기준은 댓글에 적어둘게.`,
    difference: `${hook}\n\n재료를 많이 넣는 것보다\n양념 비율에서 맛 차이가 꽤 나더라.\n\n정확한 계량은 댓글에 적어둘게.`,
    simple: `${recipe.dishName} 복잡하게 볼 필요 없더라.\n\n필요한 재료랑 양념 비율만 딱 정리해두면 편해.\n\n${recipe.servings} 기준은 댓글에 적어둘게.`,
    ratio: `${recipe.dishName}은 진짜 양념 비율이 중요하더라.\n\n대충 넣으면 매번 맛이 달라져서\n${recipe.servings} 기준으로 정리해봤어.\n\n계량은 댓글에 적어둘게.`,
    ingredient: `${recipe.dishName} 만들 때\n재료 종류보다 각각 얼마나 넣는지가 더 헷갈리더라.\n\n보기 쉽게 ${recipe.servings} 기준으로 정리해둘게.`,
    leftover: `${recipe.dishName} 해먹고 싶을 때\n재료 이것저것 찾기 귀찮아서\n필요한 것만 한 번에 보기 좋게 정리해봤어.\n\n댓글에 적어둘게.`,
  };
  return variants[style];
}

function buildRecipeCommentText(recipe) {
  const label = pickOne(SECRET_LABELS);
  const linkLead = pickOne(LINK_LEADS);
  const makeIngredients = (count) => recipe.ingredients.slice(0, count).map((x) => `▪ ${x.name} ${x.amount}`).join('\n');
  const optionalLine = recipe.optional.length ? `\n✔ 취향껏 ${recipe.optional.slice(0, 4).join(', ')} 추가` : '';

  let text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n\n${makeIngredients(10)}${optionalLine}\n\n♦ ${label}\n${recipe.secretIngredient}\n\n${linkLead}`;

  // 쿠팡 고지문과 링크가 뒤에 붙을 공간을 충분히 남긴다. 조리순서는 절대 넣지 않는다.
  if (text.length > 270) {
    text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n\n${makeIngredients(8)}\n\n♦ ${label}: ${recipe.secretIngredient}\n\n${linkLead}`;
  }
  if (text.length > 240) {
    text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n${makeIngredients(7)}\n♦ ${label}: ${recipe.secretIngredient}\n${linkLead}`;
  }
  return text;
}

function scoreCoupangProduct(product, searchKeyword) {
  const name = String(product?.name || '').toLowerCase();
  const terms = String(searchKeyword || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matched = terms.filter((term) => name.includes(term)).length;
  let score = matched * 20;
  if (terms.length && matched === terms.length) score += 20;
  if (product?.isRocket) score += 10;
  if (product?.image) score += 3;
  if (product?.url) score += 2;
  return score;
}

async function chooseCoupangProduct(accountId, searchKeyword) {
  const products = await coupangApi.searchProducts(accountId, searchKeyword, 8);
  if (!products.length) throw new Error(`쿠팡에서 "${searchKeyword}" 관련 상품을 찾지 못했습니다`);
  return products.map((product, index) => ({ product, index, score: scoreCoupangProduct(product, searchKeyword) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].product;
}

async function buildRecipeAutopilot({ account, target }) {
  const topic = pickRecipeTopic();
  console.log(`[Recipe] 레시피형 시작 — 주제="${topic}"`);
  const video = await findRecipeVideo(account.id, topic, account.autopilot_youtube_order || 'relevance');
  const recipe = await generateRecipe(account.id, topic, video);
  const product = await chooseCoupangProduct(account.id, recipe.coupangSearchKeyword);
  const foodPhotos = await findRecipePhotos(recipe, topic);
  const imageUrl = foodPhotos[0]?.imageUrl || null;
  const extraImageUrl = foodPhotos[1]?.imageUrl || null;
  const imageSourceLabel = extraImageUrl ? 'Pexels 요리사진 2장' : imageUrl ? 'Pexels 요리사진 1장' : '없음';

  console.log(`[Recipe] 핵심 재료="${recipe.secretIngredient}" 쿠팡검색="${recipe.coupangSearchKeyword}" 선택상품="${product.name}"`);
  return {
    text: buildRecipePostText(recipe), recipeCommentText: buildRecipeCommentText(recipe), link: product.url,
    imageUrl, extraImageUrl, imageSourceLabel, product, keyword: recipe.coupangSearchKeyword,
    trendNote: `레시피형 · ${recipe.dishName}`, recipe, youtubeSource: video, pexelsPhotos: foodPhotos, target,
  };
}

module.exports = { buildRecipeAutopilot };
