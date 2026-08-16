const axios = require('axios');

const FOOD_QUERY_MAP = {
  '비빔국수':'Korean spicy noodles','김치찌개':'kimchi stew','된장찌개':'Korean soybean stew','제육볶음':'Korean spicy pork',
  '닭볶음탕':'Korean spicy chicken stew','떡볶이':'tteokbokki','계란볶음밥':'egg fried rice','김치볶음밥':'kimchi fried rice',
  '오징어볶음':'spicy squid','두부조림':'braised tofu','감자조림':'braised potato','어묵볶음':'Korean fish cake',
  '진미채볶음':'spicy dried squid','멸치볶음':'stir fried anchovy','양념계란':'marinated eggs','계란장':'soy marinated eggs',
  '콩나물국':'bean sprout soup','순두부찌개':'soft tofu stew','냉면':'Korean cold noodles','비빔면':'spicy noodles','파스타':'pasta dish',
  '짜파게티 응용 레시피':'black bean noodles','라면 맛있게 끓이는 법':'Korean ramen','간장계란밥':'egg rice','닭갈비':'Korean spicy chicken',
  '고추장찌개':'Korean spicy stew','부대찌개':'Korean army stew','골뱅이무침':'spicy seafood salad','메밀국수':'buckwheat noodles',
  '잔치국수':'Korean noodle soup','비빔밥':'bibimbap','카레':'curry rice','마파두부':'mapo tofu','무생채':'spicy radish salad',
  '오이무침':'spicy cucumber salad','깻잎무침':'Korean perilla leaves','두부강정':'crispy glazed tofu','감자채볶음':'stir fried potato','콩나물무침':'seasoned bean sprouts'
};

function resolveQuery(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  return FOOD_QUERY_MAP[q] || q.replace(/[가-힣]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchFoodPhotos({ apiKey, query, count = 2 }) {
  if (!apiKey) return [];
  const search = resolveQuery(query);
  if (!search) return [];
  const wanted = Math.max(1, Math.min(2, Number(count) || 2));
  const res = await axios.get('https://pixabay.com/api/', {
    params: { key: apiKey, q: search, image_type: 'photo', category: 'food', safesearch: 'true', per_page: 20, order: 'popular' },
    timeout: 15000,
  });
  const hits = Array.isArray(res.data?.hits) ? res.data.hits : [];
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const url = hit.largeImageURL || hit.webformatURL;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ id: hit.id, imageUrl: url, pageURL: hit.pageURL || '', tags: hit.tags || '', searchQuery: search, source: 'pixabay' });
    if (out.length >= wanted) break;
  }
  console.log(`[Pixabay] ${out.length ? `음식사진 ${out.length}장` : '음식사진 없음'} — query="${search}"`);
  return out;
}

module.exports = { searchFoodPhotos };
