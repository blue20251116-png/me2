const axios = require('axios');

const FOOD_QUERY_MAP = {
  '비빔국수': { search: 'bibim guksu Korean spicy noodles', tokens: ['bibim guksu', 'spicy noodles'] },
  '김치찌개': { search: 'kimchi jjigae Korean kimchi stew', tokens: ['kimchi jjigae', 'kimchi stew'] },
  '된장찌개': { search: 'doenjang jjigae Korean soybean paste stew', tokens: ['doenjang jjigae', 'soybean paste stew'] },
  '제육볶음': { search: 'jeyuk bokkeum Korean spicy pork', tokens: ['jeyuk bokkeum', 'spicy pork'] },
  '닭볶음탕': { search: 'dakbokkeumtang Korean spicy braised chicken', tokens: ['dakbokkeumtang', 'braised chicken'] },
  '떡볶이': { search: 'tteokbokki Korean spicy rice cakes', tokens: ['tteokbokki', 'spicy rice cakes'] },
  '계란볶음밥': { search: 'egg fried rice', tokens: ['egg fried rice'] },
  '김치볶음밥': { search: 'kimchi fried rice', tokens: ['kimchi fried rice'] },
  '오징어볶음': { search: 'ojingeo bokkeum Korean spicy squid', tokens: ['ojingeo bokkeum', 'spicy squid'] },
  '두부조림': { search: 'dubu jorim Korean braised tofu', tokens: ['dubu jorim', 'braised tofu'] },
  '감자조림': { search: 'Korean braised potatoes gamja jorim', tokens: ['braised potatoes', 'gamja jorim'] },
  '어묵볶음': { search: 'Korean stir fried fish cake eomuk', tokens: ['stir fried fish cake', 'eomuk'] },
  '진미채볶음': { search: 'Korean spicy dried squid strips', tokens: ['dried squid strips', 'spicy dried squid'] },
  '멸치볶음': { search: 'Korean stir fried anchovies myeolchi bokkeum', tokens: ['stir fried anchovies', 'myeolchi bokkeum'] },
  '양념계란': { search: 'Korean marinated eggs', tokens: ['marinated eggs'] },
  '계란장': { search: 'Korean soy marinated eggs mayak eggs', tokens: ['soy marinated eggs', 'mayak eggs'] },
  '콩나물국': { search: 'Korean bean sprout soup kongnamul guk', tokens: ['bean sprout soup', 'kongnamul guk'] },
  '순두부찌개': { search: 'sundubu jjigae Korean soft tofu stew', tokens: ['sundubu jjigae', 'soft tofu stew'] },
  '냉면': { search: 'naengmyeon Korean cold noodles', tokens: ['naengmyeon', 'cold noodles'] },
  '비빔면': { search: 'Korean spicy mixed noodles bibim myeon', tokens: ['spicy mixed noodles', 'bibim myeon'] },
  '파스타': { search: 'pasta dish', tokens: ['pasta', 'spaghetti'] },
  '짜파게티 응용 레시피': { search: 'jjapagetti black bean noodles', tokens: ['black bean noodles', 'jjapagetti'] },
  '라면 맛있게 끓이는 법': { search: 'Korean ramyeon ramen noodles', tokens: ['ramyeon', 'ramen noodles'] },
  '간장계란밥': { search: 'Korean egg rice soy sauce', tokens: ['egg rice', 'soy sauce rice'] },
  '닭갈비': { search: 'dakgalbi Korean spicy chicken', tokens: ['dakgalbi', 'spicy chicken'] },
  '고추장찌개': { search: 'Korean gochujang stew', tokens: ['gochujang stew'] },
  '부대찌개': { search: 'budae jjigae Korean army stew', tokens: ['budae jjigae', 'army stew'] },
  '골뱅이무침': { search: 'golbaengi muchim Korean spicy whelk salad', tokens: ['golbaengi muchim', 'whelk salad'] },
  '메밀국수': { search: 'Korean buckwheat noodles memil guksu', tokens: ['buckwheat noodles', 'memil guksu'] },
  '잔치국수': { search: 'janchi guksu Korean noodle soup', tokens: ['janchi guksu', 'noodle soup'] },
  '비빔밥': { search: 'bibimbap Korean mixed rice', tokens: ['bibimbap', 'mixed rice'] },
  '카레': { search: 'Korean curry rice', tokens: ['curry rice'] },
  '마파두부': { search: 'mapo tofu', tokens: ['mapo tofu'] },
  '무생채': { search: 'Korean spicy radish salad musaengchae', tokens: ['spicy radish salad', 'musaengchae'] },
  '오이무침': { search: 'Korean spicy cucumber salad oi muchim', tokens: ['spicy cucumber salad', 'oi muchim'] },
  '깻잎무침': { search: 'Korean perilla leaf side dish', tokens: ['perilla leaf'] },
  '두부강정': { search: 'crispy fried tofu glazed tofu', tokens: ['crispy tofu', 'fried tofu', 'glazed tofu'] },
  '감자채볶음': { search: 'Korean stir fried shredded potato', tokens: ['stir fried potato', 'shredded potato'] },
  '콩나물무침': { search: 'Korean seasoned bean sprouts', tokens: ['seasoned bean sprouts'] },
};

function normalizeDishQuery(query) {
  return String(query || '').replace(/\s+korean\s+food.*$/i, '').replace(/\s+dish.*$/i, '').trim();
}
function resolveFoodQuery(query) {
  const normalized = normalizeDishQuery(query);
  if (!normalized) return null;
  if (FOOD_QUERY_MAP[normalized]) return { dish: normalized, ...FOOD_QUERY_MAP[normalized], mapped: true };
  if (/[가-힣]/.test(normalized)) return null;
  const words = normalized.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3).slice(0, 5);
  return { dish: normalized, search: normalized, tokens: words, mapped: false };
}
function textMatchesDish(photo, resolved) {
  const haystack = `${photo?.alt || ''} ${photo?.url || ''}`.toLowerCase();
  if (!haystack || !resolved?.tokens?.length) return false;
  return resolved.tokens.some(token => {
    const parts = String(token).toLowerCase().split(/\s+/).filter(Boolean);
    return parts.length && parts.every(part => haystack.includes(part));
  });
}
function visualSignature(photo) {
  const alt = String(photo?.alt || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const photographer = String(photo?.photographer || '').toLowerCase().trim();
  return `${photographer}|${alt}`;
}
function toItem(photo,resolved){const imageUrl=photo.src?.large2x||photo.src?.large||photo.src?.portrait||photo.src?.original||null;if(!imageUrl)return null;return{id:photo.id,imageUrl,photographer:photo.photographer||'',photographerUrl:photo.photographer_url||'',pexelsUrl:photo.url||'',alt:photo.alt||'',matchedDish:resolved.dish,searchQuery:resolved.search,source:'pexels'};}
async function searchFoodPhotos({ apiKey, query, count = 3 }) {
  if (!apiKey) return [];
  const resolved = resolveFoodQuery(query);
  if (!resolved) { console.log(`[Pexels] 정확한 이미지 검색어 없음 — 원문="${String(query || '').trim()}"`); return []; }
  const wanted = Math.max(1, Math.min(3, Number(count) || 3));
  const res = await axios.get('https://api.pexels.com/v1/search', { headers:{Authorization:apiKey}, params:{query:resolved.search,per_page:30,orientation:'portrait',size:'large'}, timeout:15000 });
  const photos = Array.isArray(res.data?.photos) ? res.data.photos : [];
  const seenIds=new Set(),seenVisuals=new Set(),exact=[],fallback=[];
  for(const photo of photos){if(!photo?.id||seenIds.has(photo.id))continue;seenIds.add(photo.id);const sig=visualSignature(photo);if(sig&&seenVisuals.has(sig))continue;if(sig)seenVisuals.add(sig);const item=toItem(photo,resolved);if(!item)continue;if(textMatchesDish(photo,resolved))exact.push(item);else if(!resolved.mapped)fallback.push(item);if(exact.length>=wanted)break;}
  const out=exact.slice(0,wanted);
  if(out.length<wanted&&!resolved.mapped){for(const item of fallback){if(!out.some(x=>x.imageUrl===item.imageUrl))out.push(item);if(out.length>=wanted)break;}}
  if(!out.length)console.log(`[Pexels] 음식사진 후보 없음 — dish="${resolved.dish}" search="${resolved.search}"`);else console.log(`[Pexels] 후보 ${out.length}장 — dish="${resolved.dish}" search="${resolved.search}" exact=${exact.length}`);
  return out;
}
async function searchFoodPhoto({apiKey,query}){const photos=await searchFoodPhotos({apiKey,query,count:1});return photos[0]||null;}
module.exports={searchFoodPhoto,searchFoodPhotos};
