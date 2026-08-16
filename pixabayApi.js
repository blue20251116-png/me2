const axios = require('axios');

const FOOD_QUERY_MAP = {
  '비빔국수':{search:'Korean spicy noodles',tokens:['spicy noodles']},'김치찌개':{search:'kimchi stew',tokens:['kimchi','stew']},'된장찌개':{search:'Korean soybean stew',tokens:['soybean','stew']},'제육볶음':{search:'Korean spicy pork',tokens:['spicy','pork']},
  '닭볶음탕':{search:'Korean spicy chicken stew',tokens:['chicken','stew']},'떡볶이':{search:'tteokbokki',tokens:['tteokbokki']},'계란볶음밥':{search:'egg fried rice',tokens:['egg','fried rice']},'김치볶음밥':{search:'kimchi fried rice',tokens:['kimchi','fried rice']},
  '오징어볶음':{search:'spicy squid',tokens:['squid']},'두부조림':{search:'braised tofu',tokens:['tofu']},'감자조림':{search:'braised potato',tokens:['potato']},'어묵볶음':{search:'Korean fish cake',tokens:['fish cake']},
  '진미채볶음':{search:'spicy dried squid',tokens:['dried squid']},'멸치볶음':{search:'stir fried anchovy',tokens:['anchovy','anchovies']},'양념계란':{search:'marinated eggs',tokens:['marinated','egg']},'계란장':{search:'soy marinated eggs',tokens:['marinated','egg']},
  '콩나물국':{search:'bean sprout soup',tokens:['bean sprout','soup']},'순두부찌개':{search:'soft tofu stew',tokens:['tofu','stew']},'냉면':{search:'Korean cold noodles',tokens:['cold noodles']},'비빔면':{search:'spicy noodles',tokens:['spicy noodles']},'파스타':{search:'pasta dish',tokens:['pasta','spaghetti']},
  '짜파게티 응용 레시피':{search:'black bean noodles',tokens:['black bean','noodles']},'라면 맛있게 끓이는 법':{search:'Korean ramen',tokens:['ramen','ramyeon']},'간장계란밥':{search:'egg rice',tokens:['egg','rice']},'닭갈비':{search:'Korean spicy chicken',tokens:['chicken']},
  '고추장찌개':{search:'Korean spicy stew',tokens:['spicy','stew']},'부대찌개':{search:'Korean army stew',tokens:['army stew','budae']},'골뱅이무침':{search:'spicy seafood salad',tokens:['seafood','salad']},'메밀국수':{search:'buckwheat noodles',tokens:['buckwheat','noodles']},
  '잔치국수':{search:'Korean noodle soup',tokens:['noodle','soup']},'비빔밥':{search:'bibimbap',tokens:['bibimbap']},'카레':{search:'curry rice',tokens:['curry','rice']},'마파두부':{search:'mapo tofu',tokens:['mapo','tofu']},'무생채':{search:'spicy radish salad',tokens:['radish','salad']},
  '오이무침':{search:'spicy cucumber salad',tokens:['cucumber','salad']},'깻잎무침':{search:'Korean perilla leaves',tokens:['perilla']},'두부강정':{search:'crispy glazed tofu',tokens:['tofu']},'감자채볶음':{search:'stir fried potato',tokens:['potato']},'콩나물무침':{search:'seasoned bean sprouts',tokens:['bean sprout']}
};

function resolveQuery(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (FOOD_QUERY_MAP[q]) return {dish:q,...FOOD_QUERY_MAP[q]};
  if (/[가-힣]/.test(q)) return null;
  const tokens=q.toLowerCase().split(/[^a-z0-9]+/).filter(x=>x.length>=3).slice(0,4);
  return {dish:q,search:q,tokens};
}

function hitMatches(hit,resolved){
  const hay=`${hit?.tags||''} ${hit?.pageURL||''}`.toLowerCase();
  return resolved.tokens.some(token=>{
    const parts=String(token).toLowerCase().split(/\s+/).filter(Boolean);
    return parts.length&&parts.every(part=>hay.includes(part));
  });
}

async function searchFoodPhotos({ apiKey, query, count = 2 }) {
  if (!apiKey) return [];
  const resolved = resolveQuery(query);
  if (!resolved){console.log(`[Pixabay] 정확한 이미지 검색어 없음 — 원문="${String(query||'').trim()}"`);return []}
  const wanted = Math.max(1, Math.min(2, Number(count) || 2));
  const res = await axios.get('https://pixabay.com/api/', {
    params: { key: apiKey, q: resolved.search, image_type: 'photo', category: 'food', safesearch: 'true', per_page: 40, order: 'popular' },
    timeout: 15000,
  });
  const hits = Array.isArray(res.data?.hits) ? res.data.hits : [];
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    if(!hitMatches(hit,resolved))continue;
    const url = hit.largeImageURL || hit.webformatURL;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ id: hit.id, imageUrl: url, pageURL: hit.pageURL || '', tags: hit.tags || '', searchQuery: resolved.search, matchedDish:resolved.dish, source: 'pixabay' });
    if (out.length >= wanted) break;
  }
  console.log(`[Pixabay] ${out.length ? `정확 매칭 ${out.length}장` : '정확한 음식사진 없음'} — dish="${resolved.dish}" query="${resolved.search}"`);
  return out;
}

module.exports = { searchFoodPhotos };