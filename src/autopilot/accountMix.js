'use strict';
// Fixed-persona owner accounts only (config/accountPersonas.json): what kind of post each slot gets
// (Coupang-linked vs link-free recipe/product vs everyday post), the re-uploaded video cap and
// product/source/media/text de-duplication. Every function is a no-op for other accounts, so their
// autopilot behaviour is unchanged.
const { db } = require('../infra/db');
const { dayKeyKst, dayBounds } = require('../publish/slots');
const {
  accountPersonaFor,
  isPersonaAccount,
  personaAccountIds,
  accountPersonaSettings,
} = require('../content/accountPersonas');
const { chooseFrame } = require('../content/postFrames');

// 2026-10-14 (user: "응 전부 수정해" after the reach report): per KST day an owner account posts at
// most maxLinked Coupang-linked posts spread evenly through the day, at most maxDaily link-free
// everyday text posts (the 4th post of the day; the runner only publishes one with a photo), and
// everything else as a link-free recipe/product post from Threads material ('unlinked').
// 16/day, 5 linked, 1 daily -> L U U D L U U L U U L U U L U U.
function decideSlotKind({ linked = 0, plain = 0, daily = 0, maxLinked = 5, maxDaily = 1, dailyCap = 16 } = {}) {
  const total = linked + plain + daily;
  // Several daily posts are spread through the day (with maxDaily 1 this is the old "4th post").
  if (daily < maxDaily && total >= 3 && daily * Math.max(1, dailyCap) <= total * maxDaily) return 'daily';
  if (linked < maxLinked && linked * Math.max(1, dailyCap) <= total * maxLinked) return 'linked';
  return 'unlinked';
}

// 2026-10-21 (owner: "각 게시물당 쿠팡 링크가 안들어가는 문제도 해결해"): 198 owner-account product
// posts (10/14-10/20) went out as 'product-nolink' with no Coupang comment at all, because an
// 'unlinked' slot dropped the link for products too. A product post now always carries its Partners
// link; only a recipe may still go out link-free, and only when the config caps linked posts below
// the daily volume (accountPersonas.json maxLinkedPerDay).
function linkFreeAllowed(kind, mode) {
  return kind === 'unlinked' && mode === 'recipe';
}

function dayMix(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN link IS NOT NULL AND link<>'' THEN 1 ELSE 0 END) linked,
              SUM(CASE WHEN (link IS NULL OR link='') AND content_mode='daily' THEN 1 ELSE 0 END) daily,
              SUM(CASE WHEN (link IS NULL OR link='') AND (content_mode IS NULL OR content_mode<>'daily') THEN 1 ELSE 0 END) plain
         FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`
    )
    .get(accountId, start, end);
  return { linked: Number(row?.linked || 0), plain: Number(row?.plain || 0), daily: Number(row?.daily || 0) };
}

// null for accounts without a fixed persona (caller keeps its original path).
function slotKind(accountId, scheduledAt) {
  if (!isPersonaAccount(accountId)) return null;
  const day = dayKeyKst(new Date(scheduledAt || Date.now()));
  const cfg = accountPersonaSettings();
  return decideSlotKind({
    ...dayMix(accountId, day),
    maxLinked: cfg.maxLinkedPerDay,
    maxDaily: cfg.maxDailyPerDay,
    dailyCap: cfg.dailyPostsMax,
  });
}

// Posts of this account on the slot's KST day that carry a re-uploaded Threads video (a plain
// video_url or a media bundle with a VIDEO item).
function videoPostsOnDay(accountId, scheduledAt) {
  const [start, end] = dayBounds(dayKeyKst(new Date(scheduledAt || Date.now())));
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted') AND ((video_url IS NOT NULL AND video_url<>'') OR image_url LIKE '%VIDEO%')`
      )
      .get(accountId, start, end)?.c || 0
  );
}
// May this slot use a video re-uploaded from another creator? Owner accounts: only while the day
// holds fewer than maxVideoPerDay such posts (about a third). Always true for other accounts.
function videoAllowed(accountId, scheduledAt) {
  if (!isPersonaAccount(accountId)) return true;
  return videoPostsOnDay(accountId, scheduledAt) < accountPersonaSettings().maxVideoPerDay;
}

function normKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '')
    .slice(0, 40);
}
// Identity of a post: Coupang product id, product name, source post URL, topic, search term and
// (when a file was imported) the media file hash. Any shared key counts as the same post material.
function dedupeKeysFor({ product, sourceUrl, topic, searchTerm, mediaHash } = {}) {
  const keys = [];
  const add = (prefix, v) => {
    const k = normKey(v);
    if (k.length >= 2) keys.push(`${prefix}:${k}`);
  };
  if (product?.productId) add('p', product.productId);
  add('n', product?.name);
  if (sourceUrl) keys.push(`s:${String(sourceUrl).split(/[?#]/)[0].toLowerCase()}`);
  add('t', topic);
  if (searchTerm && !/ground-truth/i.test(searchTerm)) add('q', searchTerm);
  if (mediaHash) add('m', mediaHash);
  return [...new Set(keys)];
}
function encodeKeys(keys) {
  return keys && keys.length ? `|${keys.join('|')}|` : null;
}
function decodeKeys(v) {
  return String(v || '')
    .split('|')
    .filter(Boolean);
}

// Keys that identify the material itself (source post, product, product name, media file): these
// must not repeat across ANY owner account within dedupeOwnDays. Topic/search-term keys are looser
// ("텀블러") and only block other accounts on the same KST day.
const MATERIAL_KEY = /^[spnm]:/;

// Returns { key, scope, accountId } when this account already used one of the keys within
// dedupeOwnDays (before or after the slot), another owner account used the same source post /
// product / media file within dedupeOwnDays, or the same topic/search term on the slot's KST day;
// otherwise null.
function findDuplicate(accountId, keys, scheduledAt) {
  if (!isPersonaAccount(accountId) || !keys?.length) return null;
  const wanted = new Set(keys);
  const slotMs = Date.parse(scheduledAt || '') || Date.now();
  const days = accountPersonaSettings().dedupeOwnDays;
  const from = new Date(slotMs - days * 86400000).toISOString();
  const to = new Date(slotMs + days * 86400000).toISOString();
  const own = db
    .prepare(
      `SELECT dedupe_keys k FROM posts WHERE account_id=? AND dedupe_keys IS NOT NULL AND status IN ('pending','posted') AND scheduled_at>=? AND scheduled_at<?`
    )
    .all(accountId, from, to);
  for (const r of own) {
    const hit = decodeKeys(r.k).find(k => wanted.has(k));
    if (hit) return { key: hit, scope: 'own', accountId: Number(accountId) };
  }
  const others = personaAccountIds().filter(id => id !== Number(accountId));
  if (!others.length) return null;
  const [dayStart, dayEnd] = dayBounds(dayKeyKst(new Date(slotMs)));
  const cross = db
    .prepare(
      `SELECT account_id a, dedupe_keys k, scheduled_at s FROM posts WHERE account_id IN (${others.map(() => '?').join(',')}) AND dedupe_keys IS NOT NULL AND status IN ('pending','posted') AND scheduled_at>=? AND scheduled_at<?`
    )
    .all(...others, from, to);
  for (const r of cross) {
    const sameDay = r.s >= dayStart && r.s < dayEnd;
    const hit = decodeKeys(r.k).find(k => wanted.has(k) && (sameDay || MATERIAL_KEY.test(k)));
    if (hit) return { key: hit, scope: 'cross', accountId: Number(r.a) };
  }
  return null;
}

// ---------- near-duplicate text ----------
// Character-bigram Jaccard over Hangul/alnum only. Calibrated on the 2026-10-14 queue: real repeats
// (same lip-balm story twice on one account, the same source rewritten on two accounts) scored
// 0.23-0.33, unrelated posts <= 0.20.
const SIMILAR_TEXT_THRESHOLD = 0.22;
function bigrams(text) {
  const s = String(text || '').replace(/[^0-9a-zA-Z가-힣]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function textSimilarity(a, b) {
  const A = bigrams(a),
    B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
// { scope, accountId, postId, score } when a post of ANY owner account within dedupeOwnDays of the
// slot reads like this text; null otherwise (and always for customer accounts).
function findSimilarText(accountId, text, scheduledAt, { threshold = SIMILAR_TEXT_THRESHOLD, excludeId = null } = {}) {
  if (!isPersonaAccount(accountId) || !String(text || '').trim()) return null;
  const slotMs = Date.parse(scheduledAt || '') || Date.now();
  const days = Math.max(1, accountPersonaSettings().dedupeOwnDays);
  const from = new Date(slotMs - days * 86400000).toISOString();
  const to = new Date(slotMs + days * 86400000).toISOString();
  const ids = personaAccountIds();
  const rows = db
    .prepare(
      `SELECT id, account_id a, text FROM posts WHERE account_id IN (${ids.map(() => '?').join(',')}) AND status IN ('pending','posted') AND scheduled_at>=? AND scheduled_at<?`
    )
    .all(...ids, from, to);
  let best = null;
  for (const r of rows) {
    if (excludeId && Number(r.id) === Number(excludeId)) continue;
    const score = textSimilarity(text, r.text);
    if (score >= threshold && (!best || score > best.score))
      best = {
        scope: Number(r.a) === Number(accountId) ? 'own' : 'cross',
        accountId: Number(r.a),
        postId: Number(r.id),
        score,
      };
  }
  return best;
}

// Filters handed to the material engine so a duplicate or off-persona source is skipped before
// any vision/AI work, and a duplicate product before the post is written. {} for other accounts.
function generationFilters(accountId, scheduledAt) {
  const persona = accountPersonaFor(accountId);
  if (!persona) return {};
  const rotate = accountPersonaSettings().rotatePersonas;
  return {
    materialFilter(material) {
      const text = `${material?.sourceText || material?.text || ''}\n${material?.authorReplies || ''}`;
      if (!rotate && persona.skipMaterial && persona.skipMaterial.test(text)) return `persona ${persona.id} 소재 아님`;
      const dup = findDuplicate(accountId, dedupeKeysFor({ sourceUrl: material?.url }), scheduledAt);
      return dup ? `중복 소재 ${dup.scope} #${dup.accountId} ${dup.key}` : null;
    },
    productFilter(candidate) {
      const dup = findDuplicate(accountId, dedupeKeysFor(candidate), scheduledAt);
      return dup ? `중복 상품 ${dup.scope} #${dup.accountId} ${dup.key}` : null;
    },
  };
}

// Frame for this account's next linked product post: whichever of A/B it used less in the last
// 7 days (50:50 on a tie), so each account alternates. null for accounts without a fixed persona.
function frameCounts(accountId, days = 7) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT post_frame f, COUNT(*) c FROM posts WHERE account_id=? AND post_frame IS NOT NULL AND status IN ('pending','posted') AND scheduled_at>=? GROUP BY post_frame`
    )
    .all(accountId, from);
  const counts = {};
  for (const r of rows) counts[r.f] = Number(r.c);
  return counts;
}
function chooseFrameFor(accountId, random = Math.random) {
  if (!isPersonaAccount(accountId)) return null;
  try {
    return chooseFrame(frameCounts(accountId), random);
  } catch (e) {
    // post_frame column missing (migration failed): still pick a frame, just without history.
    console.warn(`[AutopilotV3][FRAME] 이력 조회 실패 → 무작위 reason="${e.message}"`);
    return chooseFrame({}, random);
  }
}

function duplicateError(dup) {
  const what = dup.key ? dup.key : `비슷한 글 #${dup.postId} (${Number(dup.score || 0).toFixed(2)})`;
  const err = new Error(`중복 상품/키워드/글 (${dup.scope} #${dup.accountId} ${what}) → 이 슬롯 생성 생략`);
  err.code = 'DUPLICATE_TOPIC';
  return err;
}

module.exports = {
  decideSlotKind,
  linkFreeAllowed,
  dayMix,
  slotKind,
  videoPostsOnDay,
  videoAllowed,
  dedupeKeysFor,
  encodeKeys,
  decodeKeys,
  findDuplicate,
  textSimilarity,
  findSimilarText,
  SIMILAR_TEXT_THRESHOLD,
  generationFilters,
  frameCounts,
  chooseFrameFor,
  duplicateError,
};
