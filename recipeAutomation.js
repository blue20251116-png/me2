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

  const queries = [`${topic} 레시피`, `${topic} 황금레시피`, `${topic} 밥도둑`];

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
      console.log(
        `[Recipe] Pexels 이미지 검색 실패 "${query}":`,
        err.response?.data?.error || err.message
      );
    }
  }

  return [];
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
    ? data.optional.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  const steps = Array.isArray(data.steps)
    ? data.steps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5)
    : [];

  const dishName = String(data.dishName || fallbackDish || '오늘의 요리').trim();
  const servings = String(data.servings || '1~2인분').trim();
  const secretIngredient = String(data.secretIngredient || '').trim();
  const coupangSearchKeyword = String(data.coupangSearchKeyword || secretIngredient || '').trim();
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
- 레시피 안에서 쿠팡 검색에 자연스럽게 연결할 수 있는 핵심 재료 하나를 정한다.
- 핵심 재료는 단순히 흔한 기본 재료보다, 실제로 따로 사두면 요리가 편해지는 상품을 우선한다.

문체:
- 사람이 직접 올린 것처럼 짧고 자연스러운 반말.
- 음슴체 금지.
- ㅋㅋ는 필요할 때 0~1회.
- 광고 카피처럼 시작하지 않는다.
- "이제 집에서", "간편하게 만들어보자", "요즘 이런 조합이 자주 보여서", "맛집 부럽지 않은", "강추", "필수템", "구매하세요", "인생템" 같은 표현 금지.
- 실제 경험처럼 보이기 위해 가족, 지인, 식당 사장, 전문가에게 들었다는 설정을 지어내지 않는다.
- 직접 먹어봤다/해봤다는 사실도 입력 근거가 없으면 지어내지 않는다.

정확성:
- 영상 제목/설명에 실제 재료나 계량이 있으면 우선 참고한다.
- 부족한 부분은 일반적인 레시피 기준으로 보완할 수 있다.
- 영상에 없는 내용을 영상 제작자가 말했다고 주장하지 않는다.
- 특정 영상 제작자/유명인이 쿠팡 상품을 사용했다고 지어내지 않는다.
- 출처, 판매량, 가족 경험, 직접 사용 경험을 근거 없이 만들지 않는다.
- 건강효과/치료효과를 주장하지 않는다.

레시피 규칙:
- 계량은 1스푼, 1/2스푼, 100ml, 1팩처럼 한국식으로 명확히 쓴다.
- 핵심 재료 최대 12개.
- 조리순서 최대 5단계.
- secretIngredient는 소스, 양념, 육수, 장류, 오일, 향신료, 손질식품처럼 쿠팡에서 검색하기 좋고 반복 구매 가능성이 있는 재료를 우선한다.
- 레시피에 자연스럽다면 냉면육수, 쯔유, 참치액, 굴소스, 멸치육수팩, 액젓, 고추기름, 다진마늘, 파스타소스, 카레가루, 육수코인 같은 사두면 편한 재료를 우선 검토한다.
- 소금, 설탕, 물, 후추 같은 기본재료는 secretIngredient로 가급적 선택하지 않는다.
- coupangSearchKeyword는 실제 사용자가 쿠팡에서 검색할 법한 1~3단어 상품 키워드로 쓴다.
- 상품을 팔기 위해 레시피를 왜곡하지 않는다.

JSON 형식:
{
  "dishName":"요리명",
  "servings":"1인분",
  "hook":"짧고 자연스러운 한 문장",
  "tastePoint":"맛 포인트",
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

위 정보를 참고해 실제 따라 하기 좋은 레시피 JSON을 만들어줘.
본문용 hook은 광고 문장보다 사람들이 실제로 Threads에 적을 법한 짧은 문장으로 써줘.
핵심 재료는 레시피를 해치지 않는 범위에서 쿠팡에서 따로 검색해서 살 이유가 있는 재료를 우선해.`;

  const data = await callOpenAI(accountId, system, user, 1600);
  return sanitizeRecipeJson(data, topic);
}

function buildRecipePostText(recipe) {
  const style = pickOne(POST_STYLES);
  const hook = recipe.hook || `${recipe.dishName}은 양념 비율 하나만 달라도 맛이 꽤 달라지더라`;

  const variants = {
    problem: `${recipe.dishName} 만들 때\n똑같이 재료 넣는데도 맛이 매번 조금씩 다르잖아.\n\n양념 비율이랑 마지막 재료 하나만 정리해두면 훨씬 편해.\n${recipe.servings} 기준은 댓글에 적어둘게.`,
    difference: `${hook}\n\n재료를 많이 넣는 것보다\n양념 비율이랑 마지막 한 가지에서 맛 차이가 꽤 나더라.\n\n정확한 계량은 댓글에 적어둘게.`,
    simple: `${recipe.dishName} 복잡하게 할 필요 없더라.\n\n재료 몇 개랑 양념 비율만 맞추면 되고\n마지막에 넣는 재료 하나가 포인트야.\n\n${recipe.servings} 레시피는 댓글에 적어둘게.`,
    ratio: `${recipe.dishName}은 진짜 양념 비율이 중요하더라.\n\n대충 넣으면 매번 맛이 달라져서\n이번엔 ${recipe.servings} 기준으로 딱 정리해봤어.\n\n계량이랑 포인트 재료는 댓글에 적어둘게.`,
    ingredient: `${recipe.dishName} 만들 때\n재료보다 마지막에 뭘 넣느냐가 은근 중요하더라.\n\n많이 넣을 필요도 없고\n맛 방향만 잡아주는 정도면 돼.\n\n정확한 양은 댓글에 적어둘게.`,
    leftover: `${recipe.dishName} 해먹고 싶을 때\n재료 이것저것 많이 살 필요는 없더라.\n\n있는 재료에 양념 비율만 맞추고\n포인트 하나만 추가하면 돼.\n\n레시피는 댓글에 적어둘게.`,
  };

  return variants[style];
}

function buildRecipeCommentText(recipe) {
  const label = pickOne(SECRET_LABELS);
  const linkLead = pickOne(LINK_LEADS);

  const ingredientLines = recipe.ingredients
    .slice(0, 10)
    .map((x) => `▪ ${x.name} ${x.amount}`)
    .join('\n');

  const optionalLine = recipe.optional.length
    ? `\n✔ 취향껏 ${recipe.optional.slice(0, 5).join(', ')} 추가해도 좋아` 
    : '';

  const stepLines = recipe.steps
    .slice(0, 4)
    .map((x, i) => `${i + 1}. ${x}`)
    .join('\n');

  let text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n${ingredientLines}${optionalLine}\n\n♦ ${label}: ${recipe.secretIngredient}\n${stepLines}\n\n${linkLead}`;

  // 최종 고지문/쿠팡 링크가 뒤에 붙으므로 레시피 댓글 자체는 여유 있게 제한한다.
  // 내용이 길면 재료/조리순서를 우선 유지하면서 단계적으로 압축한다.
  if (text.length > 320) {
    const compactIngredients = recipe.ingredients
      .slice(0, 8)
      .map((x) => `▪ ${x.name} ${x.amount}`)
      .join('\n');
    const compactSteps = recipe.steps
      .slice(0, 3)
      .map((x, i) => `${i + 1}. ${x}`)
      .join('\n');

    text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n${compactIngredients}\n\n♦ ${label}: ${recipe.secretIngredient}\n${compactSteps}\n\n${linkLead}`;
  }

  if (text.length > 300) {
    const compactIngredients = recipe.ingredients
      .slice(0, 7)
      .map((x) => `▪ ${x.name} ${x.amount}`)
      .join('\n');
    const compactSteps = recipe.steps
      .slice(0, 2)
      .map((x, i) => `${i + 1}. ${x}`)
      .join('\n');

    text = `✅ ${recipe.dishName} (${recipe.servings} 기준)\n${compactIngredients}\n♦ ${label}: ${recipe.secretIngredient}\n${compactSteps}\n${linkLead}`;
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
  if (!products.length) {
    throw new Error(`쿠팡에서 "${searchKeyword}" 관련 상품을 찾지 못했습니다`);
  }

  return products
    .map((product, index) => ({
      product,
      index,
      score: scoreCoupangProduct(product, searchKeyword),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].product;
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

  const foodPhotos = await findRecipePhotos(recipe, topic);
  const imageUrl = foodPhotos[0]?.imageUrl || null;
  const extraImageUrl = foodPhotos[1]?.imageUrl || null;
  const imageSourceLabel = extraImageUrl
    ? 'Pexels 요리사진 2장'
    : imageUrl
      ? 'Pexels 요리사진 1장'
      : '없음';

  console.log(
    `[Recipe] 핵심 재료="${recipe.secretIngredient}" 쿠팡검색="${recipe.coupangSearchKeyword}" 선택상품="${product.name}"`
  );

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
    pexelsPhotos: foodPhotos,
    target,
  };
}

module.exports = {
  buildRecipeAutopilot,
};
