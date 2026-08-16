const axios = require('axios');
const { db, getAccount, getSystemApiSettings, getPexelsApiKey, getPixabayApiKey } = require('./db');
const youtubeApi = require('./youtubeApi');
const coupangApi = require('./coupangApi');
const { searchFoodPhotos: searchPexels } = require('./pexelsApi');
const { searchFoodPhotos: searchPixabay } = require('./pixabayApi');
const { rankKeywordsByTrend } = require('./naverTrends');

const FALLBACK_RECIPE_TOPICS = ['비빔국수','김치찌개','된장찌개','제육볶음','닭볶음탕','떡볶이','계란볶음밥','김치볶음밥','오징어볶음','두부조림','감자조림','어묵볶음','진미채볶음','멸치볶음','양념계란','계란장','콩나물국','순두부찌개','냉면','비빔면','파스타','짜파게티 응용 레시피','라면 맛있게 끓이는 법','간장계란밥','닭갈비','고추장찌개','부대찌개','골뱅이무침','메밀국수','잔치국수','비빔밥','카레','마파두부','무생채','오이무침','깻잎무침','두부강정','감자채볶음','콩나물무침'];
const HIGH_INTENT = ['참치액','연두','육수코인','냉면육수','쯔유','굴소스','멸치액젓','까나리액젓','맛술','미림','고추기름','치킨스톡','다시팩','비빔장','파스타소스','카레가루','들기름','다진마늘'];
const LOW_VALUE_SECRET = /^(소금|설탕|물|후추|식용유|계란|달걀|양파|대파)$/;
const EXCLUDED_PRODUCT_RE = /사료|간식|영양제|건강기능식품|보호대|장난감|세정제|세제|샴푸|화장품|비누|기계|도구|커터|슬라이서|분쇄기|다지기|보관용기|용기/i;
const ALIAS_GROUPS = [
  ['미림','맛술','요리술'],['멸치액젓','액젓','멸치액'],['까나리액젓','액젓'],
  ['멸치육수','멸치육수팩','다시팩','멸치다시팩','육수팩'],['육수코인','코인육수','한알육수'],
  ['참치액','참치액젓','참치액기스'],['굴소스','오이스터소스','oyster sauce'],
  ['다진마늘','간마늘','다진 마늘'],['국간장','조선간장','한식간장'],['진간장','양조간장'],
  ['치킨스톡','치킨스톡분말','치킨스톡큐브'],['쯔유','츠유','메밀장국'],
  ['비빔장','비빔소스','비빔국수양념'],['파스타소스','스파게티소스','토마토파스타소스'],
  ['카레가루','카레분말','카레'],['들기름','들깨기름']
];

function getOpenAIKey(id) {
  const a = getAccount(id), s = getSystemApiSettings();
  return s.openai_api_key || process.env.OPENAI_API_KEY || a?.openai_api_key || null;
}

async function callOpenAI(id, system, user, maxTokens = 1400) {
  const key = getOpenAIKey(id);
  if (!key) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature: 0.86, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, { headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, timeout: 30000 });
  return JSON.parse(r.data.choices[0].message.content);
}

function recentRecipeContext(accountId, limit = 10) {
  try {
    return db.prepare(`SELECT text, recipe_comment_text, trend_note FROM posts WHERE account_id=? ORDER BY id DESC LIMIT ?`).all(accountId, limit)
      .map((r) => ({ text: String(r.text || ''), comment: String(r.recipe_comment_text || ''), trend: String(r.trend_note || '') }));
  } catch { return []; }
}

async function visionCheck(id, dish, imageUrl) {
  const key = getOpenAIKey(id);
  if (!key) return { accept: false, reason: 'OpenAI API 키 없음' };
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', temperature: 0, max_tokens: 180, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '너는 음식 사진 검수기다. 목표 음식과 실제 사진이 명확히 같은 완성요리일 때만 accept=true. 생재료, 포장제품, 조리 전 재료, 다른 음식, 불명확한 사진은 false. JSON={"accept":true/false,"confidence":0-100,"reason":"짧은 한국어 이유"}' },
        { role: 'user', content: [{ type: 'text', text: `목표 음식: ${dish}\n이 사진이 완성된 ${dish} 요리 사진인지 보수적으로 판정해.` }, { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }] }
      ]
    }, { headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, timeout: 30000 });
    const d = JSON.parse(r.data.choices[0].message.content); const confidence = Number(d.confidence) || 0;
    return { accept: d.accept === true && confidence >= 80, confidence, reason: String(d.reason || '') };
  } catch (e) { return { accept: false, confidence: 0, reason: e.message }; }
}

async function validatePhotos(id, dish, candidates) {
  const approved = [];
  for (const p of candidates) {
    if (!p?.imageUrl) continue;
    const v = await visionCheck(id, dish, p.imageUrl);
    console.log(`[Recipe][Vision] ${v.accept ? '승인' : '거절'} ${dish} ${v.confidence || 0}점`);
    if (v.accept) approved.push(p);
    if (approved.length >= 2) break;
  }
  return approved;
}

async function generateTopicPool(accountId) {
  const recent = recentRecipeContext(accountId, 14);
  const used = recent.map((r) => r.trend).filter(Boolean).join(' | ');
  const system = `너는 한국 Threads용 레시피 주제 기획자다. JSON만 출력한다.
찌개/국물, 볶음/조림, 면, 밥, 에어프라이어/오븐, 브런치, 술안주, 자취요리, 분식, 아시아 퓨전 등 최소 6개 카테고리를 섞어 실생활에서 해먹기 쉬운 서로 다른 요리 15개를 제안한다.
최근 주제와 겹치지 않는다. JSON={"topics":["주제1",...]}`;
  try {
    const d = await callOpenAI(accountId, system, `최근 기록:\n${used || '없음'}`);
    return [...new Set((d.topics || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 15);
  } catch { return []; }
}

async function topicCandidates(id) {
  const recent = recentRecipeContext(id, 14).map((r) => r.trend).join('|');
  let pool = (await generateTopicPool(id)).filter((x) => !recent.includes(x));
  if (pool.length < 8) pool.push(...FALLBACK_RECIPE_TOPICS.filter((x) => !recent.includes(x) && !pool.includes(x)).slice(0, 8 - pool.length));
  if (pool.length < 8) for (const x of FALLBACK_RECIPE_TOPICS) { if (!pool.includes(x)) pool.push(x); if (pool.length >= 8) break; }
  const c = [...new Set(pool)].sort(() => Math.random() - .5).slice(0, 8);
  try {
    const r = await rankKeywordsByTrend(id, c);
    if (r?.length) return r.map((x) => ({ topic: x.keyword, trendNote: `네이버 데이터랩 레시피 트렌드 · ${x.keyword} (${x.avgRatio.toFixed(1)})` }));
  } catch {}
  return c.map((x) => ({ topic: x, trendNote: `레시피형 · ${x}` }));
}

async function video(id, topic, order) {
  const key = getSystemApiSettings().youtube_api_key || process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try { return (await youtubeApi.searchVideos({ apiKey: key, keyword: `${topic} 레시피`, order: order || 'relevance', maxResults: 5 }))[0] || null; }
  catch { return null; }
}

function normalizeServings(value) {
  let s = String(value || '').trim().replace(/\s+/g, '');
  if (!s) return '2인분'; if (/^\d+$/.test(s)) return `${s}인분`; if (/^\d+[~\-]\d+$/.test(s)) return `${s.replace('-', '~')}인분`;
  if (/^\d+인$/.test(s)) return `${s}분`; if (/^\d+[~\-]\d+인$/.test(s)) return `${s.replace('-', '~')}분`; if (/^\d+(?:~\d+)?인분$/.test(s)) return s;
  const m = s.match(/(\d+)(?:[~\-](\d+))?/); return m ? (m[2] ? `${m[1]}~${m[2]}인분` : `${m[1]}인분`) : '2인분';
}
function norm(v) { return String(v || '').replace(/\s+/g, '').toLowerCase(); }
function aliasesFor(k) { const key = String(k || '').trim(), nk = norm(key); for (const g of ALIAS_GROUPS) if (g.some((x) => { const nx = norm(x); return nk === nx || nk.includes(nx) || nx.includes(nk); })) return [...new Set([key, ...g])]; return [key]; }
function sameIngredient(a, b) { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x.includes(y) || y.includes(x)) return true; return aliasesFor(a).some((v) => aliasesFor(b).some((w) => { const nv = norm(v), nw = norm(w); return nv === nw || nv.includes(nw) || nw.includes(nv); })); }
function chooseFallbackSecret(ingredients, requested) { const exact = ingredients.find((x) => sameIngredient(x.name, requested)); if (exact) return exact.name; for (const hi of HIGH_INTENT) { const found = ingredients.find((x) => sameIngredient(x.name, hi) && !LOW_VALUE_SECRET.test(x.name)); if (found) return found.name; } const useful = ingredients.find((x) => !LOW_VALUE_SECRET.test(x.name)); return useful?.name || ingredients[0]?.name || ''; }

function clean(d, fallback) {
  const ingredients = (d.ingredients || []).map((x) => ({ name: String(x.name || '').trim(), amount: String(x.amount || '').trim() })).filter((x) => x.name && x.amount).slice(0, 12);
  if (!ingredients.length) throw new Error('레시피 AI 응답 부족');
  const steps = Array.isArray(d.steps) ? d.steps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6) : [];
  if (steps.length < 3) throw new Error('조리 순서가 부족합니다');
  const requested = String(d.secretIngredient || d.coupangSearchKeyword || '').trim();
  const secretIngredient = chooseFallbackSecret(ingredients, requested);
  if (!secretIngredient) throw new Error('제휴 핵심재료를 선택할 수 없습니다');
  return {
    dishName: String(d.dishName || fallback).trim(), servings: normalizeServings(d.servings), ingredients,
    optional: (d.optional || []).slice(0, 5), steps, secretIngredient, coupangSearchKeyword: secretIngredient,
    hook: String(d.hook || '').trim(), hookStyle: String(d.hookStyle || '').trim(), kickLine: String(d.kickLine || '').trim()
  };
}

async function generate(id, topic, v) {
  const recent = recentRecipeContext(id, 8).map((r, i) => `[${i + 1}] ${r.text}`).join('\n---\n');
  const system = `너는 한국 Threads에서 직접 해먹은 음식을 공유하는 일반 사용자이자 정확한 레시피 작성자다. JSON만 출력한다.

[레시피 정확성]
- servings는 '2인분', '2~3인분'처럼 쓴다.
- ingredients는 실제 필요한 재료와 정확한 계량을 적는다.
- steps는 실제 따라할 수 있는 구체적 조리 순서 3~6단계다.
- ingredients에 없는 재료를 조리 단계에서 새로 만들지 않는다.
- secretIngredient는 ingredients에 실제 포함된 재료 중 하나만 선택한다.
- 소금/설탕/물/후추/식용유/계란/양파/대파는 secretIngredient로 고르지 않는다.
- 가능하면 ${HIGH_INTENT.join(', ')} 중 실제 레시피에 들어간 차별화 재료를 우선한다.

[본문 hook]
레시피 블로그처럼 설명하지 말고 사람이 Threads에 툭 올린 4~7줄짜리 생활 썰처럼 쓴다.
음식 이름/재료 목록부터 시작하지 않는다.
아래 유형 중 하나만 골라 쓰고 최근 글과 같은 유형/첫 문장/표현을 피한다:
1) 냉장고 재료 처리하다 만든 상황
2) 술안주/야식이 필요했던 상황
3) 귀찮아서 대충 만들었는데 성공한 상황
4) 밖에서 먹던 걸 따라 해본 상황
5) 재료 몇 개 없어서 즉흥적으로 만든 상황
6) 반찬 고민하다 만든 상황
7) 예상 밖 조합이 잘 맞은 상황
8) 한입 먹고 바로 다시 해먹고 싶어진 반응

자연스러운 반말을 쓴다. 음슴체 금지. '~함/~임/~됨' 금지.
ㅋㅋ/ㅎㅎ는 필요할 때만 0~2회.
"풍미가 일품", "환상적인 조화", "누구나 쉽게", "강력 추천", "최고의 레시피" 같은 블로그/광고 문구 금지.
맛은 구체적으로 한 가지 정도만 표현한다. 예: 겉이 바삭하다, 대파가 달달해진다, 소스가 잘 배었다.
가족/친구/남편의 구체적 반응을 사실처럼 지어내지 않는다.
허위 사용기간, 체중감량, 건강효능, 판매수치 등을 만들지 않는다.
마지막에는 레시피가 댓글에 있다는 말을 자연스럽게 한 줄 넣되 매번 같은 CTA를 쓰지 않는다.
예문을 그대로 복사하지 않는다.

[kickLine]
댓글에서 핵심 재료 링크 앞에 붙일 1줄을 만든다. 예: "근데 이건 소스가 거의 다 함ㅋㅋ" 같은 결.
과장 광고문이 아니라 자연스러운 한마디여야 한다.

JSON={"dishName":"","servings":"","hookStyle":"","hook":"","ingredients":[{"name":"","amount":""}],"optional":[],"steps":["","",""],"secretIngredient":"","coupangSearchKeyword":"","kickLine":""}`;

  const user = `주제: ${topic}\n참고 영상 제목: ${v?.title || '없음'}\n\n최근 Threads 글(표현/상황/첫 문장을 피할 것):\n${recent || '없음'}`;
  return clean(await callOpenAI(id, system, user), topic);
}

async function photos(id, recipe, topic) {
  const queries = [recipe.dishName, topic].filter((q, i, a) => q && a.indexOf(q) === i); let bestSingle = null;
  const pk = getPexelsApiKey() || process.env.PEXELS_API_KEY;
  if (pk) for (const q of queries) try { const p = await searchPexels({ apiKey: pk, query: q, count: 8 }); const ok = await validatePhotos(id, recipe.dishName, p); if (ok.length >= 2) return { photos: ok.slice(0, 2), source: 'Pexels+Vision' }; if (ok.length === 1 && !bestSingle) bestSingle = { photos: ok.slice(0, 1), source: 'Pexels+Vision' }; } catch {}
  const bk = getPixabayApiKey() || process.env.PIXABAY_API_KEY;
  if (bk) for (const q of queries) try { const p = await searchPixabay({ apiKey: bk, query: q, count: 8 }); const ok = await validatePhotos(id, recipe.dishName, p); if (ok.length >= 2) return { photos: ok.slice(0, 2), source: 'Pixabay+Vision' }; if (ok.length === 1 && !bestSingle) bestSingle = { photos: ok.slice(0, 1), source: 'Pixabay+Vision' }; } catch {}
  return bestSingle || { photos: [], source: null };
}

function ensureCommentCta(hook) {
  const h = String(hook || '').trim();
  if (!h) return '';
  if (/댓글/.test(h)) return h;
  const ctas = ['재료랑 순서는 댓글에 적어둘게', '또 해먹으려고 레시피는 댓글에 남겨둠ㅋㅋ', '계량까지 댓글에 적어둘게', '레시피 필요한 사람은 댓글 보면 돼'];
  return `${h}\n\n${ctas[Math.floor(Math.random() * ctas.length)]}`;
}
function post(r) {
  const fallback = `냉장고에 있는 걸로 대충 만들어봤는데\n이 조합 생각보다 괜찮네ㅋㅋ\n\n${r.dishName} 또 해먹을 것 같아서\n계량이랑 순서는 댓글에 적어둘게`;
  return ensureCommentCta(r.hook) || fallback;
}
function comment(r) {
  const ing = r.ingredients.slice(0, 10).map((x) => `${x.name} ${x.amount}`).join('\n');
  const cooking = r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const kick = r.kickLine || `근데 이건 ${r.secretIngredient}가 은근 핵심임ㅋㅋ`;
  return `🍳 ${r.dishName}\n\n재료 (${r.servings})\n${ing}\n\n만드는 법\n${cooking}\n\n${kick}\n내가 고른 ${r.secretIngredient}는 아래에👇`;
}

function productMatchesKeyword(name, k) { const n = norm(name); return aliasesFor(k).some((a) => { const x = norm(a); return x && n.includes(x); }); }
function isExcludedProduct(p) { return EXCLUDED_PRODUCT_RE.test(String(p?.name || '')); }
function score(p, k, i) { const n = String(p.name || '').toLowerCase(); let s = productMatchesKeyword(n, k) ? 80 : 0; s += Math.max(0, 15 - i); if (p.rank) s += Math.max(0, 25 - p.rank); if (p.isRocket) s += 8; if (/업소용|대용량|말통|식자재|10kg|12kg|14kg|15kg|18kg|20kg/.test(n)) s -= 45; return s; }

async function aiPickProduct(id, ingredient, results) {
  if (!results.length) return null;
  try {
    const list = results.slice(0, 8).map((p, i) => `${i}: ${p.name}`).join('\n');
    const d = await callOpenAI(id, '너는 식재료 상품 매칭 검수기다. 해당 식재료로 실제 요리에 사용할 수 있는 상품만 고른다. 완제품, 도구, 건강기능식품, 반려동물용품은 제외. JSON={"index":숫자 또는 -1,"confidence":0-100,"reason":""}', `필요한 식재료: ${ingredient}\n상품 후보:\n${list}`, 300);
    const idx = Number(d.index), confidence = Number(d.confidence) || 0;
    if (Number.isInteger(idx) && idx >= 0 && idx < results.length && confidence >= 65) return results[idx];
  } catch {}
  return null;
}

async function searchProductFlexible(id, k) {
  let results;
  try { results = await coupangApi.searchProducts(id, k, 10); }
  catch (e) { if (coupangApi.isRateLimitError?.(e)) throw e; return null; }
  if (!results.length) return null;
  const safe = results.filter((p) => !isExcludedProduct(p)); if (!safe.length) return null;
  const ranked = safe.map((p, i) => ({ p, score: score(p, k, i) })).filter((x) => productMatchesKeyword(x.p.name, k)).sort((a, b) => b.score - a.score);
  if (ranked.length) return ranked[0].p;
  return await aiPickProduct(id, k, safe);
}
function ingredientCandidates(r) { const names = r.ingredients.map((x) => x.name).filter(Boolean), out = []; const push = (k) => { if (!k || LOW_VALUE_SECRET.test(String(k).trim())) return; if (!out.some((x) => sameIngredient(x, k))) out.push(k); }; push(r.secretIngredient); for (const hi of HIGH_INTENT) { const f = names.find((n) => sameIngredient(n, hi)); if (f) push(f); } for (const n of names) push(n); return out.slice(0, 2); }
async function findAffiliateProduct(id, r) { const candidates = ingredientCandidates(r); for (const ingredient of candidates) { const p = await searchProductFlexible(id, ingredient); if (p) { const actual = r.ingredients.find((x) => sameIngredient(x.name, ingredient))?.name || ingredient; r.secretIngredient = actual; r.coupangSearchKeyword = actual; return p; } } throw new Error(`쿠팡 매칭 상품 없음: ${candidates.join(' / ')}`); }

async function buildRecipeAutopilot({ account, target }) {
  const cooldown = coupangApi.getApiCooldown?.(account.id);
  if (cooldown) { const e = new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`); e.code = 'COUPANG_RATE_LIMIT'; e.isCoupangRateLimit = true; throw e; }
  const candidates = await topicCandidates(account.id); let lastError = null;
  for (const picked of candidates.slice(0, 6)) {
    try {
      const v = await video(account.id, picked.topic, account.autopilot_youtube_order);
      const r = await generate(account.id, picked.topic, v);
      const p = await findAffiliateProduct(account.id, r);
      const img = await photos(account.id, r, picked.topic);
      if (img.photos.length < 1) continue;
      return { text: post(r), recipeCommentText: comment(r), link: p.url, imageUrl: img.photos[0].imageUrl, extraImageUrl: img.photos[1]?.imageUrl || null, imageSourceLabel: `${img.source} 요리사진 ${img.photos.length}장`, product: p, keyword: r.coupangSearchKeyword, trendNote: picked.trendNote, recipe: r, youtubeSource: v, target };
    } catch (e) { if (coupangApi.isRateLimitError?.(e)) throw e; lastError = e; console.log(`[Recipe] 후보 실패 ${picked.topic}: ${e.message}`); }
  }
  throw new Error(`유효한 레시피를 찾지 못했습니다${lastError ? `: ${lastError.message}` : ''}`);
}

module.exports = { buildRecipeAutopilot };
