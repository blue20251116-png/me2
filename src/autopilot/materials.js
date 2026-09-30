'use strict';
// Choosing source posts from benchmark accounts: dedupe, scoring, enrichment with full post details.
const { collectBenchmarkMaterials, collectPostDetails } = require('../threads/threadsCollector');
const { clean } = require('./aiCalls');

function normalized(v) {
  return clean(v)
    .toLowerCase()
    .replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g, '');
}

function hasExternalLink(t) {
  return (
    /(?:https?:\/\/|www\.)\S+/i.test(String(t || '')) || /\b(?:link\.coupang\.com|naver\.me)\b/i.test(String(t || ''))
  );
}

function isEngagementBait(text) {
  const t = clean(text);
  if (!t) return false;
  const hard = [
    /스하(?:뤼|리|루)?/i,
    /반하(?:뤼|리|루)?/i,
    /맞팔/i,
    /선팔/i,
    /팔로우\s*(?:3종|세트|가자|하면|해주|부탁|환영|갈게|갑니다)/i,
    /하트[^\n]{0,30}팔로우/i,
    /팔로우[^\n]{0,30}하트/i,
    /리포스트[^\n]{0,30}팔로우/i,
    /팔로우[^\n]{0,30}리포스트/i,
    /스레드\s*(?:이제|막)?\s*시작한\s*사람/i,
    /\d{2,6}\s*명까지\s*포기\s*못/i,
    /같이\s*성장하(?:자|쟈)/i,
    /바로\s*팔로우\s*(?:갈게|갑니다|감)/i,
    /팔로우하면\s*(?:바로|무조건)?\s*팔로우/i,
  ];
  if (hard.some(r => r.test(t))) return true;
  let hits = 0;
  for (const r of [/팔로우/i, /리포스트/i, /하트/i, /성장/i, /맞팔/i, /선팔/i]) if (r.test(t)) hits++;
  return hits >= 3;
}

function materialFingerprint(item) {
  const t = normalized(item?.text || '').replace(/\d+/g, '#');
  return t.slice(0, 260);
}

function dedupeMaterials(items) {
  const seenUrl = new Set(),
    seenText = new Set(),
    out = [];
  for (const item of items || []) {
    const url = String(item?.url || '').split(/[?#]/)[0];
    const fp = materialFingerprint(item);
    if (!url || seenUrl.has(url)) continue;
    if (fp.length >= 20 && seenText.has(fp)) continue;
    seenUrl.add(url);
    if (fp.length >= 20) seenText.add(fp);
    out.push(item);
  }
  return out;
}

function materialScore(i) {
  const t = clean(i?.text);
  if (isEngagementBait(t)) return -1000;
  let s = 0;
  if (i?.hasVideo || Number(i?.videoCount || 0) > 0) s += 2;
  if (Number(i?.imageCount || 0) > 0 || (Array.isArray(i?.images) && i.images.length)) s += 1;
  if (t.length >= 40 && t.length <= 1000) s += 4;
  else if (t.length >= 20) s += 2;
  if (/(레시피|소스|양념|재료|만드는|볶|굽|끓|에어프라이어|큰술|스푼|\bT\b)/i.test(t)) s += 5;
  if (/(비밀|핵심|이거|댓글|진짜|ㅋㅋ|꿀템|사버|추천|구매|제품)/i.test(t)) s += 3;
  if (hasExternalLink(t)) s -= 30;
  return s + Math.random();
}

async function pickThreadsMaterials() {
  const m = await collectBenchmarkMaterials({ limit: 10 });
  const filtered = (m || []).filter(
    x => x?.url && clean(x.text).length >= 12 && !hasExternalLink(x.text) && !isEngagementBait(x.text)
  );
  const u = dedupeMaterials(filtered);
  if (!u.length) throw new Error('Threads에서 사용할 소재를 찾지 못했습니다');
  u.sort((a, b) => materialScore(b) - materialScore(a));
  console.log(`[AutopilotV3][Material] 수집=${m?.length || 0} 필터후=${filtered.length} 중복제거후=${u.length}`);
  return u;
}

async function enrichThreadsMaterial(i) {
  let sourceText = clean(i?.text),
    authorReplies = '',
    images = Array.isArray(i?.images) ? i.images.filter(Boolean) : [],
    videos = [];
  if (i?.url && i?.username) {
    const d = await collectPostDetails(i.url, i.username);
    if (clean(d?.sourceText).length >= 8) sourceText = clean(d.sourceText);
    authorReplies = Array.isArray(d?.authorReplies) ? d.authorReplies.filter(Boolean).join('\n\n') : '';
    if (Array.isArray(d?.images) && d.images.length) images = d.images.filter(Boolean);
    if (Array.isArray(d?.videos)) videos = d.videos.filter(Boolean);
  }
  if (isEngagementBait(sourceText) || isEngagementBait(authorReplies))
    throw new Error('팔로우/맞팔/리포스트 유도형 소재');
  /* NO-LINK-FILTER: affiliate reply link is optional */
  return { ...i, sourceText, authorReplies, images, videos };
}

async function collectQualifiedThreadsMaterials(maxQualified = 3) {
  const candidates = await pickThreadsMaterials();
  const out = [];
  let lastError = null;
  for (const candidate of candidates.slice(0, 10)) {
    try {
      const material = await enrichThreadsMaterial(candidate);
      out.push(material);
      console.log(
        `[AutopilotV3][Material] 후보채택 ${out.length}/${maxQualified} @${material.username || '-'} 소재 후보채택 source=${material.url}`
      );
      if (out.length >= maxQualified) break;
    } catch (e) {
      lastError = e;
      console.log(
        `[AutopilotV3][Material] 제외 @${candidate.username || '-'} reason="${e.message}" source=${candidate.url}`
      );
    }
  }
  if (!out.length) throw new Error(`조건에 맞는 소재를 찾지 못했습니다${lastError ? `: ${lastError.message}` : ''}`);
  return out;
}

module.exports = { normalized, collectQualifiedThreadsMaterials };
