const axios = require('axios');

// Pexels는 한국어 세부 메뉴명을 잘못 이해하는 경우가 많아서
// 레시피 자동화에서 쓰는 메뉴는 검색용 영문명 + 검증 토큰을 명시적으로 관리한다.
// 정확한 사진을 못 찾으면 다른 'Korean food' 사진으로 대체하지 않고 빈 배열을 반환한다.
const FOOD_QUERY_MAP = {
  '비빔국수': { search: 'bibim guksu Korean spicy noodles', tokens: ['bibim', 'guksu', 'spicy noodles'] },
  '김치찌개': { search: 'kimchi jjigae Korean kimchi stew', tokens: ['kimchi', 'jjigae', 'stew'] },
  '된장찌개': { search: 'doenjang jjigae Korean soybean paste stew', tokens: ['doenjang', 'soybean', 'stew'] },
  '제육볶음': { search: 'jeyuk bokkeum Korean spicy pork', tokens: ['jeyuk', 'spicy pork', 'pork'] },
  '닭볶음탕': { search: 'dakbokkeumtang Korean spicy braised chicken', tokens: ['dakbokkeumtang', 'braised chicken', 'chicken'] },
  '떡볶이': { search: 'tteokbokki Korean spicy rice cakes', tokens: ['tteokbokki', 'rice cake'] },
  '계란볶음밥': { search: 'egg fried rice', tokens: ['egg', 'fried rice'] },
  '김치볶음밥': { search: 'kimchi fried rice', tokens: ['kimchi', 'fried rice'] },
  '오징어볶음': { search: 'ojingeo bokkeum Korean spicy squid', tokens: ['squid', 'ojingeo'] },
  '두부조림': { search: 'dubu jorim Korean braised tofu', tokens: ['tofu', 'dubu'] },
  '감자조림': { search: 'Korean braised potatoes gamja jorim', tokens: ['potato', 'gamja'] },
  '어묵볶음': { search: 'Korean stir fried fish cake eomuk', tokens: ['fish cake', 'eomuk'] },
  '진미채볶음': { search: 'Korean spicy dried squid strips', tokens: ['dried squid', 'squid'] },
  '멸치볶음': { search: 'Korean stir fried anchovies myeolchi bokkeum', tokens: ['anchov', 'myeolchi'] },
  '양념계란': { search: 'Korean marinated eggs', tokens: ['egg', 'marinated'] },
  '계란장': { search: 'Korean soy marinated eggs mayak eggs', tokens: ['egg', 'marinated'] },
  '콩나물국': { search: 'Korean bean sprout soup kongnamul guk', tokens: ['bean sprout', 'soup'] },
  '순두부찌개': { search: 'sundubu jjigae Korean soft tofu stew', tokens: ['sundubu', 'tofu', 'stew'] },
  '냉면': { search: 'naengmyeon Korean cold noodles', tokens: ['naengmyeon', 'cold noodle'] },
  '비빔면': { search: 'Korean spicy mixed noodles bibim myeon', tokens: ['spicy noodle', 'mixed noodle', 'bibim'] },
  '파스타': { search: 'pasta dish', tokens: ['pasta', 'spaghetti', 'noodle'] },
  '짜파게티 응용 레시피': { search: 'jjapagetti black bean noodles', tokens: ['black bean noodle', 'jjapagetti', 'jajang'] },
  '라면 맛있게 끓이는 법': { search: 'Korean ramyeon ramen noodles', tokens: ['ramen', 'ramyeon', 'noodle'] },
  '간장계란밥': { search: 'Korean egg rice soy sauce', tokens: ['egg', 'rice'] },
  '닭갈비': { search: 'dakgalbi Korean spicy chicken', tokens: ['dakgalbi', 'spicy chicken', 'chicken'] },
  '고추장찌개': { search: 'Korean gochujang stew', tokens: ['gochujang', 'stew'] },
  '부대찌개': { search: 'budae jjigae Korean army stew', tokens: ['budae', 'army stew'] },
  '골뱅이무침': { search: 'golbaengi muchim Korean spicy whelk salad', tokens: ['golbaengi', 'whelk', 'sea snail'] },
  '메밀국수': { search: 'Korean buckwheat noodles memil guksu', tokens: ['buckwheat', 'noodle', 'memil'] },
  '잔치국수': { search: 'janchi guksu Korean noodle soup', tokens: ['janchi', 'noodle soup', 'noodle'] },
  '비빔밥': { search: 'bibimbap Korean mixed rice', tokens: ['bibimbap', 'mixed rice'] },
  '카레': { search: 'Korean curry rice', tokens: ['curry', 'rice'] },
  '마파두부': { search: 'mapo tofu', tokens: ['mapo', 'tofu'] },
  '무생채': { search: 'Korean spicy radish salad musaengchae', tokens: ['radish', 'musaengchae'] },
  '오이무침': { search: 'Korean spicy cucumber salad oi muchim', tokens: ['cucumber', 'oi muchim'] },
  '깻잎무침': { search: 'Korean perilla leaf side dish', tokens: ['perilla', 'leaf'] },
  '두부강정': { search: 'Korean crispy glazed tofu', tokens: ['tofu'] },
  '감자채볶음': { search: 'Korean stir fried shredded potato', tokens: ['potato'] },
  '콩나물무침': { search: 'Korean seasoned bean sprouts', tokens: ['bean sprout'] },
};

function normalizeDishQuery(query) {
  return String(query || '')
    .replace(/\s+korean\s+food.*$/i, '')
    .replace(/\s+dish.*$/i, '')
    .trim();
}

function resolveFoodQuery(query) {
  const normalized = normalizeDishQuery(query);
  if (!normalized) return null;

  if (FOOD_QUERY_MAP[normalized]) {
    return { dish: normalized, ...FOOD_QUERY_MAP[normalized] };
  }

  // 한국어인데 매핑이 없는 메뉴는 Pexels에 광범위 검색을 던지지 않는다.
  // 잘못된 음식 사진보다 사진 없음이 낫다.
  if (/[가-힣]/.test(normalized)) return null;

  const words = normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 4);

  return {
    dish: normalized,
    search: normalized,
    tokens: words,
  };
}

function textMatchesDish(photo, resolved) {
  const haystack = `${photo?.alt || ''} ${photo?.url || ''}`.toLowerCase();
  if (!haystack || !resolved?.tokens?.length) return false;

  return resolved.tokens.some((token) => {
    const parts = String(token).toLowerCase().split(/\s+/).filter(Boolean);
    return parts.length && parts.every((part) => haystack.includes(part));
  });
}

function visualSignature(photo) {
  // 같은 촬영 세트/거의 같은 사진이 연속으로 들어가는 것을 조금 줄이기 위한 단순 서명.
  const alt = String(photo?.alt || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const photographer = String(photo?.photographer || '').toLowerCase().trim();
  return `${photographer}|${alt}`;
}

async function searchFoodPhotos({ apiKey, query, count = 3 }) {
  if (!apiKey) return [];

  const resolved = resolveFoodQuery(query);
  if (!resolved) {
    console.log(`[Pexels] 정확한 이미지 검색어 없음 — 원문="${String(query || '').trim()}"`);
    return [];
  }

  const wanted = Math.max(1, Math.min(3, Number(count) || 3));
  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: apiKey },
    params: {
      query: resolved.search,
      per_page: 30,
      orientation: 'portrait',
      size: 'large',
    },
    timeout: 15000,
  });

  const photos = Array.isArray(res.data?.photos) ? res.data.photos : [];
  const seenIds = new Set();
  const seenVisuals = new Set();
  const exact = [];

  for (const photo of photos) {
    if (!photo?.id || seenIds.has(photo.id)) continue;
    seenIds.add(photo.id);

    // 검색 결과라고 무조건 쓰지 않고, Pexels alt/URL에도 메뉴 특징이 확인되는 사진만 통과.
    if (!textMatchesDish(photo, resolved)) continue;

    const signature = visualSignature(photo);
    if (signature && seenVisuals.has(signature)) continue;
    if (signature) seenVisuals.add(signature);

    const imageUrl = photo.src?.large2x || photo.src?.large || photo.src?.portrait || photo.src?.original || null;
    if (!imageUrl) continue;

    exact.push({
      id: photo.id,
      imageUrl,
      photographer: photo.photographer || '',
      photographerUrl: photo.photographer_url || '',
      pexelsUrl: photo.url || '',
      alt: photo.alt || '',
      matchedDish: resolved.dish,
      searchQuery: resolved.search,
    });

    if (exact.length >= wanted) break;
  }

  if (!exact.length) {
    console.log(
      `[Pexels] 정확한 음식사진 없음 — dish="${resolved.dish}" search="${resolved.search}" (엉뚱한 음식으로 대체하지 않음)`
    );
  } else {
    console.log(
      `[Pexels] 정확 매칭 ${exact.length}장 — dish="${resolved.dish}" search="${resolved.search}"`
    );
  }

  return exact;
}

async function searchFoodPhoto({ apiKey, query }) {
  const photos = await searchFoodPhotos({ apiKey, query, count: 1 });
  return photos[0] || null;
}

module.exports = { searchFoodPhoto, searchFoodPhotos };
