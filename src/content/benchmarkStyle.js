'use strict';
// Real posts from the benchmark accounts, used as few-shot style references for every writer.
// scripts/collect-benchmark-corpus.js scrapes them into db/benchmark-corpus.jsonl; this module
// cleans that file once (profile chrome, engagement counters), and hands writers a handful of the
// best-performing posts in the same content category.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/paths');

const CORPUS_PATH = path.join(DATA_DIR, 'benchmark-corpus.jsonl');
const MIN_CHARS = 25;
const MAX_CHARS = 500;
const CLICHE = /실화냐|이거 뭔데|이게 대체|뭐길래|레전드|알던 사람 손|나야\s*나|나만\s*그런가|나만\s*그래|나만\s*좋아|나만\s*몰랐|나만임/;
// Weight-loss / medical claims the shared policy forbids stating as fact.
const HIGH_RISK = /\d+\s*(?:kg|키로|킬로)|위고비|다이어트|치료|완치|교수님/i;

const SUBTYPE_RULES = [
  { id: 'recipe-cooking', name: '요리·레시피·집밥', re: /레시피|재료|만드는\s*법|볶|끓이|끓여|에어프라이어|반찬|양념|간장|고추장|된장|식초|스푼|큰술|밥솥|국물|찌개|수육|두부|단호박/ },
  { id: 'kids-parenting', name: '육아·아이·가족일상', re: /아기|애기|육아|신생아|기저귀|이유식|분유|유모차|카시트|속싸개|장난감|어린이집|등원|초딩|머리쿵/ },
  { id: 'fitness-body', name: '운동·체형·스트레칭·통증케어', re: /운동|스트레칭|헬스|트레이너|PT|폼롤러|자세|교정|골반|어깨|승모근|두통|무릎|스쿼트|런지|플랭크|단백질|근력|근육/ },
  { id: 'home-cleaning', name: '살림·청소·주방·리빙템', re: /청소|세제|곰팡이|물때|얼룩|빨래|세탁|건조기|청소기|주방|욕실|수납|정리|냄새|배수구|시트|코스터|식탁|도마|스텐|새우|칫솔|설거지/ },
  { id: 'food-snack', name: '간식·맛집·식음료', re: /간식|과자|디저트|빵|소금빵|초코|우유|푸딩|커피|과일|귤|사과|치즈|떡|아이스크림|만두|파스타|피자|파파존스|배달|존맛|한\s*입|과즙/ },
  { id: 'beauty-fashion', name: '뷰티·피부·패션·코디', re: /피부|크림|향수|잔향|화장|메이크업|립|눈썹|애교살|브러시|모공|선크림|샴푸|머리(?!쿵)|헤어|드라이|옷|핏|바지|유니클로|코디|출근룩|크록스|슬리퍼/ },
  { id: 'tech-gadget', name: '폰·가전·꿀팁·신기템', re: /아이폰|애플|휴대폰|폰|카메라|에어팟|케이스|충전|배터리|앱|블루투스|펜슬|콘서트|조명|큐브/ },
  { id: 'life-empathy', name: '일상공감·가족·인간관계', re: /남편|아내|시댁|시어머니|친정|동생|삼촌|이모|사촌|엄마|아빠|친구|회사|출근|퇴근|인생|결혼|면허/ },
];

function detectSubType(text = '') {
  const s = String(text || '');
  for (const rule of SUBTYPE_RULES) {
    if (rule.re.test(s)) return rule.id;
  }
  return 'general-viral';
}

function subTypeLabel(subType) {
  return SUBTYPE_RULES.find(r => r.id === subType)?.name || '일상·공감·꿀팁';
}

const STOPWORDS = new Set([
  '진짜', '정말', '완전', '너무', '이거', '저거', '그냥', '내가', '나는', '우리', '요즘', '오늘', '어제',
  '사람', '생각', '느낌', '하나', '정도', '때문', '사실', '솔직히', '근데', '그래서', '아니', '일단',
]);

function extractTokens(text = '') {
  const cleaned = String(text || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase();
  const tokens = new Set();
  for (let w of cleaned.split(/\s+/)) {
    w = w.replace(/(에서|으로|에게|하고|인데|는데|해서|부터|까지|처럼|보다|이라|라고|이랑|이나|에는|에도|은|는|이|가|을|를|의|에|로|도|만|과|와)$/, '');
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.add(w);
  }
  return tokens;
}

function extractBigrams(tokens) {
  const bigrams = new Set();
  for (const t of tokens) {
    for (let i = 0; i < t.length - 1; i++) {
      bigrams.add(t.slice(i, i + 2));
    }
  }
  return bigrams;
}

// Profile innerText is "<username> [tag] <age> <body> <likes> <replies> <reposts> <shares>"; counters
// that are zero are not rendered, so only their sum is a usable engagement signal.
function parseCorpusLine(row) {
  let text = String(row.text || '').trim();
  if (!text) return null;
  // Usernames are [A-Za-z0-9._] only, so "." is the one character to escape.
  const user = String(row.username || '').replace(/\./g, '\\.');
  const head = new RegExp(
    `^(?:고정됨\\s+)?${user}\\s+(?:[^\\s]+\\s+)?(?:\\d+\\s*(?:초|분|시간|일|주)|\\d{2,4}[-./]\\s*\\d{1,2}[-./]\\s*\\d{1,2}\\.?)\\s*`
  );
  const hadHeader = head.test(text);
  if (hadHeader) {
    text = text.replace(head, '');
  }
  const counters = [];
  let m;
  while ((m = text.match(/\s(\d{1,3}(?:,\d{3})*(?:\.\d)?(?:천|만|K|M)?)$/i)) && counters.length < 4) {
    counters.unshift(m[1]);
    text = text.slice(0, m.index).trim();
  }
  if (!hadHeader && counters.length === 0) return null;
  const toNum = s => {
    const n = parseFloat(s.replace(/,/g, ''));
    if (/만/.test(s)) return n * 10000;
    if (/천|K/i.test(s)) return n * 1000;
    if (/M/i.test(s)) return n * 1e6;
    return n;
  };
  const engagement = counters.map(toNum).reduce((a, b) => a + b, 0);
  const likes = counters.length ? toNum(counters[0]) : 0;
  // On Threads, view count is typically ~65x total engagement (or ~80x likes).
  // A post with engagement >= 150 falls into the 1만~100만 (10k–1M) view tier.
  const estimatedViews = Math.min(1000000, Math.max(Math.round(engagement * 65), Math.round(likes * 80), 0));
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
  // Posts leaning on clichés voicePolicy bans would teach the model exactly those clichés (they were
  // also the weakest performers in the corpus); emoji are stripped because the policy bans them.
  if (CLICHE.test(text) || HIGH_RISK.test(text)) return null;
  text = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/gu, '').replace(/ {2,}/g, ' ').trim();
  if (/\[광고\]|^\(광고\)|광고\s*$|협찬|#광고|파트너스|coupang\.com|https?:\/\/|m\.blog\.naver/i.test(text)) return null;
  const tokens = extractTokens(text);
  return {
    username: row.username || 'benchmark',
    url: row.url,
    text,
    engagement,
    likes,
    views: estimatedViews,
    isEstimatedViews: true,
    subType: detectSubType(text),
    tokens,
    bigrams: extractBigrams(tokens),
  };
}

// Re-read when the corpus file is re-collected, without a server restart.
let cache = null,
  cacheMtime = 0;
function loadCorpus() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CORPUS_PATH).mtimeMs;
  } catch {}
  if (cache && mtime === cacheMtime) return cache;
  cacheMtime = mtime;
  const out = [],
    seen = new Set();
  try {
    for (const line of fs.readFileSync(CORPUS_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const post = parseCorpusLine(row);
      if (!post || seen.has(post.text)) continue;
      seen.add(post.text);
      out.push(post);
    }
  } catch {}
  cache = out;
  return out;
}

// Load real published posts from scheduler.db that achieved 1,000 ~ 1,000,000 views
// (with extra priority for the 1만~100만 [10,000 ~ 1,000,000] view tier).
let dbCache = null,
  dbCacheAt = 0;
const DB_CACHE_TTL_MS = 60_000;

function loadHighViewDbPosts() {
  const now = Date.now();
  if (dbCache && now - dbCacheAt < DB_CACHE_TTL_MS) return dbCache;
  dbCacheAt = now;
  const out = [];
  try {
    const { db } = require('../infra/db');
    const rows = db
      .prepare(
        `SELECT p.id, p.account_id, p.persona, p.text,
                MAX(COALESCE(i.views, 0)) AS views,
                MAX(COALESCE(i.likes, 0)) AS likes,
                MAX(COALESCE(i.replies, 0)) AS replies,
                MAX(COALESCE(i.reposts, 0)) AS reposts,
                MAX(COALESCE(i.quotes, 0)) AS quotes
         FROM posts p
         JOIN insights i ON i.post_id = p.id
         WHERE p.status = 'posted'
           AND i.views BETWEEN 1000 AND 1000000
         GROUP BY p.id
         ORDER BY views DESC
         LIMIT 120`
      )
      .all();
    const seen = new Set();
    for (const r of rows) {
      const rawText = String(r.text || '').trim();
      if (!rawText) continue;
      const lines = rawText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      let cleaned = lines
        .join(' / ')
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/gu, '')
        .replace(/ {2,}/g, ' ')
        .trim();
      if (cleaned.length < MIN_CHARS || cleaned.length > MAX_CHARS) continue;
      if (CLICHE.test(cleaned) || HIGH_RISK.test(cleaned)) continue;
      if (/\[광고\]|^\(광고\)|광고\s*$|협찬|#광고|파트너스|coupang\.com|https?:\/\//i.test(cleaned)) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      const views = Number(r.views) || 0;
      const engagement =
        (Number(r.likes) || 0) +
        (Number(r.replies) || 0) * 3 +
        (Number(r.reposts) || 0) * 2 +
        (Number(r.quotes) || 0) * 2 +
        Math.round(views / 45);
      const tokens = extractTokens(cleaned);
      out.push({
        username: `db:${r.account_id || r.id}`,
        text: cleaned,
        lineCount: lines.length,
        views,
        isEstimatedViews: false,
        engagement,
        likes: Number(r.likes) || 0,
        replies: Number(r.replies) || 0,
        persona: r.persona || null,
        subType: detectSubType(cleaned),
        tokens,
        bigrams: extractBigrams(tokens),
      });
    }
  } catch {}
  dbCache = out;
  return out;
}

function scoreCandidate(candidate, { category, querySubType, queryTokens, queryBigrams }) {
  let score = 0;
  if (candidate.category === category) score += 5;
  if (querySubType && candidate.subType === querySubType) score += 9;

  if (queryTokens && queryTokens.size > 0) {
    const candTokens = candidate.tokens || extractTokens(candidate.text);
    let tokenHits = 0;
    for (const t of queryTokens) {
      if (candTokens.has(t)) tokenHits++;
    }
    score += Math.min(tokenHits * 4.5, 18);

    if (queryBigrams && queryBigrams.size > 0) {
      const candBigrams = candidate.bigrams || extractBigrams(candTokens);
      let bgHits = 0;
      for (const bg of queryBigrams) {
        if (candBigrams.has(bg)) bgHits++;
      }
      score += Math.min(bgHits * 0.9, 6);
    }
  }

  const reach = Number(candidate.views) || Math.round((Number(candidate.engagement) || 0) * 65);
  // 1만~100만 (10,000 ~ 1,000,000) view tier gets the strongest learning weight
  if (reach >= 10000 && reach <= 1000000) {
    score += 7 + Math.min(4, Math.log10(reach / 10000) * 2);
  } else if (reach >= 1000 && reach < 10000) {
    score += 4 + (reach / 10000) * 2;
  } else {
    score += Math.min(3, Math.log10(Math.max(1, (Number(candidate.engagement) || 0) + 1)));
  }
  return score;
}

const RECIPE_HINT = /(레시피|재료|만드는\s*법|볶|끓이|끓여|에어프라이어|반찬|양념|간장|소스|밥솥)/;
const EXAMPLE_COUNT = 5;
// Examples are drawn from the best-performing similar posts in the category/subType, at most one per
// account, so the model learns from 1만~100만 (and 1천~100만) view similar posts without repeating one author.
const TOP_POOL = 25;

// classify: personas.detectPersonaCategory (passed in to avoid a require cycle).
function examplesFor(category, { classify, queryText = '', random = Math.random, count = EXAMPLE_COUNT } = {}) {
  const combined = [...loadCorpus(), ...loadHighViewDbPosts()];
  if (!combined.length) return [];
  const querySubType = queryText ? detectSubType(queryText) : null;
  const queryTokens = queryText ? extractTokens(queryText) : null;
  const queryBigrams = queryTokens ? extractBigrams(queryTokens) : null;

  const tagged = combined.map(p => {
    const cat = RECIPE_HINT.test(p.text) ? 'recipe' : classify ? classify({ text: p.text }) : 'general';
    const candidate = { ...p, category: cat, subType: p.subType || detectSubType(p.text) };
    return {
      ...candidate,
      similarityScore: scoreCandidate(candidate, { category, querySubType, queryTokens, queryBigrams }),
    };
  });

  let pool = tagged.filter(p => p.category === category || (querySubType && p.subType === querySubType));
  if (pool.length < count * 2) pool = tagged;
  pool = pool.sort((a, b) => b.similarityScore - a.similarityScore || b.engagement - a.engagement).slice(0, TOP_POOL);

  const picked = [],
    users = new Set();
  // Always include at least 1 post from the 1만~100만 (10k–1M) view tier matched by similarity
  const viral10kPool = tagged
    .filter(p => (Number(p.views) || 0) >= 9500 && (Number(p.views) || 0) <= 1000000)
    .sort((a, b) => b.similarityScore - a.similarityScore || b.views - a.views)
    .slice(0, 6);
  if (viral10kPool.length && count >= 2) {
    const topViral = viral10kPool[Math.floor(random() * Math.min(3, viral10kPool.length))];
    if (topViral) {
      users.add(topViral.username);
      picked.push(topViral);
    }
  }
  // Weighted shuffle: higher similarity + 1만~100만 view tier stay near the top while still rotating across calls
  const weighted = pool
    .map((p, idx) => [random() * (1 + idx * 0.18), p])
    .sort((a, b) => a[0] - b[0])
    .map(x => x[1]);
  for (const p of weighted) {
    if (picked.length >= count) break;
    if (users.has(p.username)) continue;
    users.add(p.username);
    picked.push(p);
  }
  return picked;
}

function formatReachTag(p) {
  const reach = Number(p.views) || 0;
  const label = subTypeLabel(p.subType);
  if (reach >= 10000) {
    const man = (reach / 10000).toFixed(reach >= 100000 ? 0 : 1).replace(/\.0$/, '');
    return `[${p.isEstimatedViews ? '추정조회수' : '조회수'} ${man}만+ · ${label}]`;
  }
  if (reach >= 1000) {
    const cheon = (reach / 1000).toFixed(1).replace(/\.0$/, '');
    return `[${p.isEstimatedViews ? '추정조회수' : '조회수'} ${cheon}천+ · ${label}]`;
  }
  return `[반응 상위 · ${label}]`;
}

function summarizeLearnedPatterns(examples) {
  if (!examples.length) return '';
  const avgLen = Math.round(examples.reduce((s, e) => s + e.text.length, 0) / examples.length);
  const subTypes = [...new Set(examples.map(e => subTypeLabel(e.subType)))].slice(0, 2).join(' / ');
  const hooks = [];
  if (examples.some(e => /\?|뭐야|뭔데|어떻게|맞아|있어\?/.test(e.text.slice(0, 45)))) {
    hooks.push('첫 문장 의문·상황 툭 던지기');
  }
  if (examples.some(e => /(남편|친구|엄마|시어머니|동생|쌤|사장님|아빠|할머니)/.test(e.text.slice(0, 55)))) {
    hooks.push('주변 인물(가족·지인·현장 전문가) 반응으로 시작');
  }
  if (examples.some(e => /\d+\s*(초|분|일|개|번|스푼|큰술|년|만원|원)/.test(e.text))) {
    hooks.push('구체적 숫자·시간(3초/5분/한 입/몇 개)으로 체감 압축');
  }
  if (!hooks.length) {
    hooks.push('설명 빼고 첫 줄부터 결과·체감 장면 직결');
  }
  return `- 학습된 유사 유형(${subTypes}) 고조회수(1천~100만 구간) 글 공통 공식: 평균 ${avgLen}자 내외 짧은 호흡 / ${hooks.join(' + ')} / 핵심 대상은 첫 줄에 광고처럼 내밀지 않고 에피소드 중반 이후 자연스럽게 등장시킬 것.`;
}

function examplesBlock(examples) {
  if (!examples.length) return '';
  const patternSummary = summarizeLearnedPatterns(examples);
  return `
[벤치마크 계정 실제 글 — 반응이 가장 좋았던 글들. 이 사람들처럼 쓴다]
아래는 이번 글과 비슷한 유형에서 조회수 1천~100만(특히 1만~100만 구간) 및 최고 반응을 기록한 실제 글들이다. 첫 줄 잡는 법, 말투(반말·음슴체·ㅋㅋ/;;/ㅠㅠ 쓰는 빈도), 문장 길이, 상품을 얼마나 늦게·가볍게 꺼내는지를 이 글들에 맞춘다. 문장·소재·표현을 그대로 베끼지 않고 리듬과 구조만 학습해서 적용한다. 수집 과정에서 줄바꿈이 "/" 또는 한 줄로 합쳐져 있으니 줄바꿈 규칙은 아래 정책을 따른다. 예시 안의 이모지·판매 문구가 아래 정책과 충돌하면 정책이 우선이다.
${patternSummary}
${examples.map((p, i) => `${i + 1}) ${formatReachTag(p)} ${p.text}`).join('\n')}
`;
}

module.exports = {
  parseCorpusLine,
  loadCorpus,
  loadHighViewDbPosts,
  detectSubType,
  examplesFor,
  examplesBlock,
  CORPUS_PATH,
};
