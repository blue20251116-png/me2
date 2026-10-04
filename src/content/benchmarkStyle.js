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
const MAX_CHARS = 400;
const CLICHE = /실화냐|이거 뭔데|이게 대체|뭐길래|레전드|알던 사람 손/;
// Weight-loss / medical claims the shared policy forbids stating as fact.
const HIGH_RISK = /\d+\s*(?:kg|키로|킬로)|위고비|다이어트|치료|완치|교수님/i;

// Profile innerText is "<username> <age> <body> <likes> <replies> <reposts> <shares>"; counters
// that are zero are not rendered, so only their sum is a usable engagement signal.
function parseCorpusLine(row) {
  let text = String(row.text || '').trim();
  // Usernames are [A-Za-z0-9._] only, so "." is the one character to escape.
  const user = String(row.username || '').replace(/\./g, '\\.');
  const head = new RegExp(
    `^${user}\\s+(?:\\d+\\s*(?:초|분|시간|일|주)|\\d{2,4}[-./]\\s*\\d{1,2}[-./]\\s*\\d{1,2}\\.?)\\s*`
  );
  if (!head.test(text)) return null;
  text = text.replace(head, '');
  const counters = [];
  let m;
  while ((m = text.match(/\s(\d{1,3}(?:,\d{3})*(?:\.\d)?(?:천|만|K|M)?)$/i)) && counters.length < 4) {
    counters.unshift(m[1]);
    text = text.slice(0, m.index).trim();
  }
  const toNum = s => {
    const n = parseFloat(s.replace(/,/g, ''));
    if (/만/.test(s)) return n * 10000;
    if (/천|K/i.test(s)) return n * 1000;
    if (/M/i.test(s)) return n * 1e6;
    return n;
  };
  const engagement = counters.map(toNum).reduce((a, b) => a + b, 0);
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
  // Posts leaning on clichés voicePolicy bans would teach the model exactly those clichés (they were
  // also the weakest performers in the corpus); emoji are stripped because the policy bans them.
  if (CLICHE.test(text) || HIGH_RISK.test(text)) return null;
  text = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/gu, '').replace(/ {2,}/g, ' ').trim();
  if (/\[광고\]|광고\s*$|협찬|#광고|파트너스|coupang\.com|https?:\/\//i.test(text)) return null;
  return { username: row.username, url: row.url, text, engagement, likes: counters.length ? toNum(counters[0]) : 0 };
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

const RECIPE_HINT = /(레시피|재료|만드는\s*법|볶|끓이|끓여|에어프라이어|반찬|양념|간장|소스|밥솥)/;
const EXAMPLE_COUNT = 5;
// Examples are drawn from the best-engaging TOP_POOL posts of the category, at most one per
// account, so the model sees what works without every prompt carrying the same five posts.
const TOP_POOL = 60;

// classify: personas.detectPersonaCategory (passed in to avoid a require cycle).
function examplesFor(category, { classify, random = Math.random, count = EXAMPLE_COUNT } = {}) {
  const corpus = loadCorpus();
  if (!corpus.length) return [];
  const tagged = corpus.map(p => ({
    ...p,
    category: RECIPE_HINT.test(p.text) ? 'recipe' : classify ? classify({ text: p.text }) : 'general',
  }));
  let pool = tagged.filter(p => p.category === category);
  if (pool.length < count * 2) pool = tagged;
  pool = pool.sort((a, b) => b.engagement - a.engagement).slice(0, TOP_POOL);
  const picked = [],
    users = new Set();
  const shuffled = pool.map(p => [random(), p]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  for (const p of shuffled) {
    if (picked.length >= count) break;
    if (users.has(p.username)) continue;
    users.add(p.username);
    picked.push(p);
  }
  return picked;
}

function examplesBlock(examples) {
  if (!examples.length) return '';
  return `
[벤치마크 계정 실제 글 — 반응이 가장 좋았던 글들. 이 사람들처럼 쓴다]
아래는 우리가 벤치마킹하는 계정들이 실제로 올려서 반응이 좋았던 글이다. 첫 줄 잡는 법, 말투(반말·음슴체·ㅋㅋ/;;/ㅠㅠ 쓰는 빈도), 문장 길이, 상품을 얼마나 늦게·가볍게 꺼내는지를 이 글들에 맞춘다. 문장·소재·표현을 그대로 베끼지 않고 리듬과 태도만 가져온다. 수집 과정에서 줄바꿈이 사라져 한 줄로 붙어 있으니, 줄바꿈 규칙은 아래 정책을 따른다. 예시 안의 이모지·판매 문구가 아래 정책과 충돌하면 정책이 우선이다.
${examples.map((p, i) => `${i + 1}) ${p.text}`).join('\n')}
`;
}

module.exports = { parseCorpusLine, loadCorpus, examplesFor, examplesBlock, CORPUS_PATH };
