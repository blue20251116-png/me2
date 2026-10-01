'use strict';
// Matching the identified item to a Coupang product ("sold-first" identity terms, country/category checks).
const coupangApi = require('../integrations/coupangApi');
const { clean } = require('./aiCalls');
const { normalized } = require('./materials');

function confidence01(v) {
  const n = Number(v) || 0;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

function sameCommerceCategory(a, b) {
  const x = normalized(a),
    y = normalized(b);
  if (!x || !y) return false;
  const groups = [
    ['올리브오일', '올리브유', '엑스트라버진올리브오일', '압착올리브유'],
    ['입욕제', '배쓰밤', '배스밤', '바스밤', '목욕입욕제', '온천입욕제'],
    ['니플패드', '니플밴드', '유두패드', '유두밴드'],
    ['얼룩제거제', '부분세제', '스팟리무버', '얼룩제거펜'],
    ['의류복원제', '세탁복원제', '옷복원제'],
  ];
  return groups.some(g => g.some(v => x.includes(normalized(v))) && g.some(v => y.includes(normalized(v))));
}

function productMatchOk(vision, product) {
  const sold = clean(vision?.soldObject);
  const name = clean(product?.name);
  if (!sold || !name) return true;
  if (sameCommerceCategory(sold, name)) return true;
  const stop = new Set(['도구', '제품', '상품', '아이템', '용품', '만들기', '재료', '요리']);
  const tokens = sold
    .split(/\s+/)
    .map(normalized)
    .filter(x => x.length >= 2 && !stop.has(x));
  const n = normalized(name);
  if (tokens.length && tokens.some(t => n.includes(t))) return true;
  const soldFood = /(떡볶이|김밥|라면|롤케이크|빵|케이크|수육|고기|한우|치킨|닭|커피|무스|오이무침)/i.test(sold);
  const productAddon = /(소스|양념|분말|가루|시즈닝|믹스|띠지|포장|용기)/i.test(name);
  if (soldFood && productAddon && !/(소스|양념|분말|가루|시즈닝|믹스)/i.test(sold)) return false;
  return tokens.length === 0;
}

const SOLD_FIRST_COUNTRY_HINTS = [
  '일본',
  '중국',
  '미국',
  '독일',
  '프랑스',
  '이탈리아',
  '영국',
  '스페인',
  '스위스',
  '호주',
  '뉴질랜드',
  '태국',
  '베트남',
  '대만',
  '홍콩',
  '캐나다',
  '터키',
  '인도',
  '인도네시아',
  '말레이시아',
  '싱가포르',
];

const SOLD_FIRST_CONTEXT_WORDS = new Set([
  '추천',
  '인기',
  '신상',
  '요즘',
  '화제',
  '핫한',
  '가성비',
  '프리미엄',
  '간편',
  '편한',
  '편리한',
  '주방',
  '주방용',
  '주방용품',
  '요리',
  '조리',
  '홈',
  '집',
  '생활',
  '생활용품',
  '정리',
  '청소',
  '욕실',
  '캠핑',
  '선물',
  '직장인',
  '다이어트',
  '식단',
]);

function soldFirstWords(v) {
  return clean(v)
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function soldFirstCountryHints(values) {
  const joined = ' ' + (values || []).map(clean).filter(Boolean).join(' ') + ' ';
  return SOLD_FIRST_COUNTRY_HINTS.filter(x => joined.includes(x));
}

function soldFirstIdentityWords(v) {
  return soldFirstWords(v)
    .map(normalized)
    .filter(x => x.length >= 2 && !SOLD_FIRST_CONTEXT_WORDS.has(x));
}

function soldFirstMerge(sold, term, requiredHints) {
  const out = [];
  const pushWord = w => {
    w = clean(w);
    if (w && !out.some(x => normalized(x) === normalized(w))) out.push(w);
  };
  for (const h of requiredHints || []) pushWord(h);
  for (const w of soldFirstWords(sold)) pushWord(w);
  for (const w of soldFirstWords(term)) {
    if (out.length >= 7) break;
    pushWord(w);
  }
  return out.join(' ').trim();
}

function buildSoldFirstTerms(analysis, vision) {
  const sold = clean(vision?.soldObject || analysis?.topic || '');
  const original = [...(vision?.searchTerms || []), ...(analysis?.searchTerms || [])].map(clean).filter(Boolean);
  const requiredHints = soldFirstCountryHints([sold, ...original, vision?.evidence]);
  const out = [];
  const push = v => {
    v = clean(v);
    if (v && !out.some(x => normalized(x) === normalized(v))) out.push(v);
  };
  const scored = original
    .map(t => {
      const hints = soldFirstCountryHints([t]);
      const soldTokens = soldFirstIdentityWords(sold);
      const tn = normalized(t);
      const overlap = soldTokens.filter(x => tn.includes(x)).length;
      return { t, score: hints.length * 100 + overlap * 10 + Math.min(t.length, 30) };
    })
    .sort((a, b) => b.score - a.score);
  if (requiredHints.length) {
    for (const row of scored) {
      push(soldFirstMerge(sold, row.t, requiredHints));
      if (out.length >= 2) break;
    }
    if (out.length < 2) push(soldFirstMerge(sold, '', requiredHints));
    return out.slice(0, 2);
  }
  if (sold) push(sold);
  for (const row of scored) {
    if (out.length >= 2) break;
    const merged = soldFirstMerge(sold, row.t, []);
    if (merged) push(merged);
  }
  if (!out.length)
    for (const t of original) {
      push(t);
      if (out.length >= 2) break;
    }
  return out.slice(0, 2);
}

function soldFirstCandidateMatch(term, productName, identityTerm) {
  const words = soldFirstIdentityWords(identityTerm || term);
  const name = normalized(productName);
  if (!words.length || !name) return { ok: false, ratio: 0, matched: [], missing: words, reason: 'identity-empty' };
  const matched = words.filter(x => name.includes(x));
  const missing = words.filter(x => !name.includes(x));
  const countries = soldFirstCountryHints([identityTerm || term]);
  const countryOk = countries.every(x => name.includes(normalized(x)));
  if (!countryOk)
    return { ok: false, ratio: matched.length / words.length, matched, missing, reason: 'identity-country-mismatch' };
  const ratio = matched.length / words.length;
  const required = words.length === 1 ? 1 : words.length === 2 ? 2 : Math.ceil(words.length * 0.67);
  return {
    ok: matched.length >= required,
    ratio,
    matched,
    missing,
    reason: matched.length >= required ? 'identity-token-match' : 'identity-token-mismatch',
  };
}

function purchasableTerm(term) {
  const t = clean(term);
  if (!t) return false;
  if (/^(운동|다이어트|건강|요리|레시피|일상|생활|식단|간식|아침|점심|저녁|홈트|헬스)$/i.test(t)) return false;
  return t.length >= 2;
}

async function findProduct(accountId, terms, identityTerm) {
  let fallback = null;
  for (const term of (terms || []).slice(0, 2)) {
    let p;
    try {
      p = await coupangApi.searchProducts(accountId, term, 8);
    } catch (e) {
      const status = Number(e?.response?.status || 0);
      if (status === 401)
        console.error(
          `[Coupang][401] stage=search account=${accountId} term="${term}" message="${e?.response?.data?.message || e.message}"`
        );
      throw e;
    }
    if (!p.length) continue;
    if (!fallback) fallback = { product: p[0], searchTerm: term };
    const identityTokens = soldFirstIdentityWords(identityTerm || term);
    const exact = p.find(x => {
      const n = normalized(x.name);
      return identityTokens.length && identityTokens.every(t => n.includes(t));
    });
    if (exact) return { product: exact, searchTerm: term };
    const ranked = p
      .map(x => ({ product: x, match: soldFirstCandidateMatch(term, x?.name, identityTerm) }))
      .filter(x => x.match.ok)
      .sort((a, b) => b.match.ratio - a.match.ratio);
    if (ranked.length) {
      const picked = ranked[0];
      console.log(
        `[AutopilotV3][COUPANG MATCH PASS] term="${term}" identity="${clean(identityTerm || term)}" product="${clean(picked.product?.name)}" ratio=${picked.match.ratio.toFixed(2)}`
      );
      return { product: picked.product, searchTerm: term };
    }
    console.warn(
      `[AutopilotV3][COUPANG MATCH REJECT] term="${term}" identity="${clean(identityTerm || term)}" candidates=${p.length} reason=identity-mismatch → 다음 검색어`
    );
    continue;
  }
  if (fallback) {
    console.warn(
      `[AutopilotV3][COUPANG MATCH FALLBACK] no confident identity match for any search term → using top result product="${clean(fallback.product?.name)}" searchTerm="${fallback.searchTerm}"`
    );
    return fallback;
  }
  return { product: null, searchTerm: null };
}

module.exports = { confidence01, productMatchOk, buildSoldFirstTerms, purchasableTerm, findProduct };
