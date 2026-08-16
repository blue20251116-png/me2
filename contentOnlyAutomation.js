const axios = require('axios');
const { getAccount, getSystemApiSettings, getPexelsApiKey, getPixabayApiKey } = require('./db');
const { searchFoodPhotos: searchPexels } = require('./pexelsApi');
const { searchFoodPhotos: searchPixabay } = require('./pixabayApi');

const FALLBACK_TOPICS = [
  '김치찌개','된장찌개','계란볶음밥','김치볶음밥','비빔국수','제육볶음','두부조림','감자조림',
  '어묵볶음','오이무침','콩나물무침','순두부찌개','파스타','비빔밥','카레','마파두부',
  '닭갈비','잔치국수','메밀국수','두부강정','감자채볶음','떡볶이'
];

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function callOpenAI(accountId, system, user, { maxTokens = 1000, json = false, temperature = 0.85 } = {}) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const payload = {
    model: 'gpt-4o-mini', temperature, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (json) payload.response_format = { type: 'json_object' };
  const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 30000,
  });
  const text = res.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 결과를 받지 못했습니다');
  return json ? JSON.parse(text) : text;
}

async function visionCheck(accountId, dish, imageUrl) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) return false;
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', temperature: 0, max_tokens: 140, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '음식 사진 검수기다. 목표 음식과 같은 완성요리가 명확할 때만 accept=true. JSON={"accept":true/false,"confidence":0-100,"reason":"짧은 이유"}' },
        { role: 'user', content: [
          { type: 'text', text: `목표 음식: ${dish}\n사진이 정확히 이 완성요리인지 판정해.` },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        ] },
      ],
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 30000 });
    const d = JSON.parse(res.data.choices[0].message.content);
    const ok = d.accept === true && Number(d.confidence || 0) >= 80;
    console.log(`[ContentOnly][Vision] ${ok ? '승인' : '거절'} dish="${dish}" confidence=${Number(d.confidence || 0)}`);
    return ok;
  } catch (e) {
    console.log(`[ContentOnly][Vision] 실패 dish="${dish}": ${e.message}`);
    return false;
  }
}

async function pickPhotos(accountId, dish) {
  const approved = [];
  const sources = [];
  const pexelsKey = getPexelsApiKey() || process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    try {
      const photos = await searchPexels({ apiKey: pexelsKey, query: dish, count: 8 });
      for (const p of photos) {
        if (p?.imageUrl && await visionCheck(accountId, dish, p.imageUrl)) approved.push(p);
        if (approved.length >= 2) break;
      }
      if (approved.length) sources.push('Pexels');
    } catch (e) { console.log(`[ContentOnly][Pexels] 실패: ${e.message}`); }
  }
  if (approved.length < 2) {
    const pixabayKey = getPixabayApiKey() || process.env.PIXABAY_API_KEY;
    if (pixabayKey) {
      try {
        const photos = await searchPixabay({ apiKey: pixabayKey, query: dish, count: 8 });
        for (const p of photos) {
          if (!p?.imageUrl || approved.some(x => x.imageUrl === p.imageUrl)) continue;
          if (await visionCheck(accountId, dish, p.imageUrl)) approved.push(p);
          if (approved.length >= 2) break;
        }
        if (approved.length) sources.push('Pixabay');
      } catch (e) { console.log(`[ContentOnly][Pixabay] 실패: ${e.message}`); }
    }
  }
  return { photos: approved.slice(0, 2), source: sources.join('+') || null };
}

async function generateRecipe(accountId, target) {
  let topics = FALLBACK_TOPICS.slice().sort(() => Math.random() - 0.5).slice(0, 8);
  try {
    const d = await callOpenAI(accountId,
      '한국 Threads용 레시피 주제 기획자다. 실생활에서 쉽게 해먹는 서로 다른 요리 8개를 JSON으로 출력한다. 너무 희귀한 요리는 제외한다. JSON={"topics":["..."]}',
      `타겟: ${target || '전체'}\n오늘 올리기 좋은 레시피 주제 8개`, { maxTokens: 400, json: true });
    if (Array.isArray(d.topics) && d.topics.length) topics = [...new Set(d.topics.map(x => String(x).trim()).filter(Boolean))].slice(0, 8);
  } catch (e) { console.log(`[ContentOnly][Topic] AI 실패, 폴백 사용: ${e.message}`); }

  for (const topic of topics.slice(0, 6)) {
    try {
      const r = await callOpenAI(accountId,
        `한국 Threads 레시피 에디터다. JSON만 출력한다. 정확한 재료와 계량, 실제 따라할 수 있는 조리 순서 3~6단계를 만든다. 자연스러운 반말을 사용하고 음슴체는 금지한다. 상품/구매/광고/제휴 이야기는 절대 넣지 않는다. hook은 실제 사람이 툭 쓴 것 같은 2~4줄 생활 상황으로 만든다. JSON={"dishName":"","servings":"2인분","hook":"","ingredients":[{"name":"","amount":""}],"steps":[""]}`,
        `주제: ${topic}`, { maxTokens: 1100, json: true });
      const dishName = String(r.dishName || topic).trim();
      const ingredients = Array.isArray(r.ingredients) ? r.ingredients.filter(x => x?.name && x?.amount).slice(0, 10) : [];
      const steps = Array.isArray(r.steps) ? r.steps.map(x => String(x || '').trim()).filter(Boolean).slice(0, 6) : [];
      if (!ingredients.length || !steps.length) throw new Error('레시피 내용 부족');
      const img = await pickPhotos(accountId, dishName);
      if (!img.photos.length) { console.log(`[ContentOnly][Recipe] 이미지 없음 → 다음 주제: ${dishName}`); continue; }
      const text = `${String(r.hook || `${dishName} 해먹고 싶을 때`).trim()}\n\n재료랑 만드는 순서는 댓글에 적어둘게.`;
      const ing = ingredients.map(x => `▪ ${String(x.name).trim()} ${String(x.amount).trim()}`).join('\n');
      const cooking = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const recipeCommentText = `✅ ${dishName} (${String(r.servings || '2인분').trim()} 기준)\n\n${ing}\n\n✅ 만드는 법\n${cooking}`;
      console.log(`[ContentOnly][Recipe] 선택 dish="${dishName}" images=${img.photos.length}`);
      return {
        text, recipeCommentText, link: null,
        imageUrl: img.photos[0].imageUrl,
        extraImageUrl: img.photos[1]?.imageUrl || null,
        imageSourceLabel: `${img.source || 'Stock'}+Vision 요리사진 ${img.photos.length}장`,
        keyword: dishName, trendNote: '쿠팡 API 없음 · 순수 레시피형', target,
      };
    } catch (e) { console.log(`[ContentOnly][Recipe] 후보 실패 "${topic}": ${e.message}`); }
  }
  throw new Error('Vision 통과 음식사진이 있는 레시피를 찾지 못했습니다');
}

async function generateDailyStory(accountId, target) {
  const system = `너는 한국 Threads에서 실제 사람이 툭 쓴 듯한 짧은 일상 공감글을 쓴다. 상품 광고나 구매 유도는 절대 하지 않는다. 3~7줄, 자연스러운 반말, 음슴체 금지. 제목/번호/해시태그/링크/이모지는 넣지 않는다. 가짜 경험, 효능, 구체적인 날씨 단정도 하지 않는다. 집, 회사, 식사, 정리, 출퇴근, 주말, 잠, 인간관계, 소비습관 같은 평범한 생활 소재 중 하나를 골라 매번 다르게 쓴다.`;
  const text = await callOpenAI(accountId, system, `타겟: ${target || '전체'}\n오늘 Threads에 올릴 자연스러운 일상글 하나만 작성해.`, { maxTokens: 350, temperature: 1.0 });
  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), link: null, imageUrl: null, extraImageUrl: null, keyword: '일상', trendNote: '쿠팡 API 없음 · 순수 일상형', target };
}

module.exports = { generateRecipe, generateDailyStory };
