'use strict';
// Fixed-persona owner accounts only (config/accountPersonas.json): what kind of post each slot gets
// (Coupang-linked vs link-free recipe/product vs everyday post), the re-uploaded video cap and
// product/source/media/text de-duplication. Every function is a no-op for other accounts, so their
// autopilot behaviour is unchanged.
const { db } = require('../infra/db');
const { dayKeyKst, dayBounds, LIVE_POST_STATUS_SQL, personaChainOptions } = require('../publish/slots');
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
  // 10/day, 3 daily -> the 4th, 6th and 8th posts (never two in a row).
  const dailyStep = Math.max(1, Math.floor((Math.max(1, dailyCap) - 3) / Math.max(1, maxDaily)));
  if (daily < maxDaily && total >= 3 + daily * dailyStep) return 'daily';
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

// 2026-11-05 (dev 0079f189): 11/03 home_tempick_ got 4 daily posts (cap 3) and chi_chi1200 2 (cap 1).
// The day mix only counted status IN ('pending','posted'), so a post in the few seconds of 'publishing'
// vanished from the count (8704 was decided while 8680 was publishing), and two generations of the same
// account-day running at once could not see each other. Every live status now counts (LIVE_POST_STATUS_SQL),
// slots still being generated count as in-flight reservations, and the runner re-checks right before insert.
const inflight = new Map(); // "accountId|dayKey" -> { linked, plain, daily, video }
function inflightKey(accountId, scheduledAt) {
  return `${Number(accountId)}|${dayKeyKst(new Date(scheduledAt || Date.now()))}`;
}
function inflightCount(accountId, dayKey, kind) {
  return Number(inflight.get(`${Number(accountId)}|${dayKey}`)?.[kind] || 0);
}
// Holds one slot of `kind` ('linked' | 'plain' | 'daily' | 'video') on the slot's KST day until release().
function reserveSlot(accountId, scheduledAt, kind) {
  const key = inflightKey(accountId, scheduledAt);
  const row = inflight.get(key) || { linked: 0, plain: 0, daily: 0, video: 0 };
  row[kind] = (row[kind] || 0) + 1;
  inflight.set(key, row);
  let done = false;
  return {
    kind,
    get active() {
      return !done;
    },
    release() {
      if (done) return;
      done = true;
      const r = inflight.get(key);
      if (!r) return;
      r[kind] = Math.max(0, (r[kind] || 0) - 1);
      if (!r.linked && !r.plain && !r.daily && !r.video) inflight.delete(key);
    },
  };
}

function dayMixFromDb(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN link IS NOT NULL AND link<>'' THEN 1 ELSE 0 END) linked,
              SUM(CASE WHEN (link IS NULL OR link='') AND content_mode='daily' THEN 1 ELSE 0 END) daily,
              SUM(CASE WHEN (link IS NULL OR link='') AND (content_mode IS NULL OR content_mode<>'daily') THEN 1 ELSE 0 END) plain
         FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND ${LIVE_POST_STATUS_SQL}`
    )
    .get(accountId, start, end);
  return { linked: Number(row?.linked || 0), plain: Number(row?.plain || 0), daily: Number(row?.daily || 0) };
}
// DB rows of the day plus slots of this account-day still being generated.
function dayMix(accountId, dayKey) {
  const m = dayMixFromDb(accountId, dayKey);
  return {
    linked: m.linked + inflightCount(accountId, dayKey, 'linked'),
    plain: m.plain + inflightCount(accountId, dayKey, 'plain'),
    daily: m.daily + inflightCount(accountId, dayKey, 'daily'),
  };
}
function maxDailyFor(accountId) {
  const cfg = accountPersonaSettings();
  return cfg.maxDailyPerDayByAccount?.[Number(accountId)] ?? cfg.maxDailyPerDay;
}

// 2026-11-06 (dev a97695f9): the KST minute of the day this account's everyday post goes to, or null
// when dailySlotTimes is not configured. Account id N -> entry (N-1) % length.
function dailySlotMinuteFor(accountId) {
  const times = accountPersonaSettings().dailySlotMinutes || [];
  if (!times.length) return null;
  const id = Math.max(1, Number(accountId) || 1);
  return times[(id - 1) % times.length];
}
// Does this slot (scheduledAt) sit on the account's everyday-post time? The template slot times carry
// this account's stagger offset (slots.js personaChainOptions), so it is taken off before comparing.
function isDailySlotTime(accountId, scheduledAt, dailyMinute) {
  const at = new Date(scheduledAt || Date.now());
  const day = dayKeyKst(at);
  const offset = Number(personaChainOptions(accountId)?.offsetMin || 0);
  const minute = Math.round((at.getTime() - Date.parse(`${day}T00:00:00+09:00`)) / 60000) - offset;
  return Math.abs(minute - dailyMinute) <= 2;
}

// null for accounts without a fixed persona (caller keeps its original path).
function slotKind(accountId, scheduledAt) {
  if (!isPersonaAccount(accountId)) return null;
  const day = dayKeyKst(new Date(scheduledAt || Date.now()));
  const cfg = accountPersonaSettings();
  const mix = dayMix(accountId, day);
  const maxDaily = maxDailyFor(accountId);
  const dailyMinute = dailySlotMinuteFor(accountId);
  if (dailyMinute != null) {
    // Time mode: the everyday post only goes to its fixed time; every other slot is linked/unlinked
    // exactly as before (the daily count still counts toward the linked spread).
    if (mix.daily < maxDaily && isDailySlotTime(accountId, scheduledAt, dailyMinute)) return 'daily';
    return decideSlotKind({ ...mix, maxLinked: cfg.maxLinkedPerDay, maxDaily: 0, dailyCap: cfg.dailyPostsMax });
  }
  return decideSlotKind({
    ...mix,
    maxLinked: cfg.maxLinkedPerDay,
    maxDaily,
    dailyCap: cfg.dailyPostsMax,
  });
}

// Posts of this account on the slot's KST day that carry a re-uploaded Threads video (a plain
// video_url or a media bundle with a VIDEO item).
// (In-flight video reservations of the day count too, see reserveSlot.)
function videoPostsOnDayFromDb(accountId, scheduledAt) {
  const [start, end] = dayBounds(dayKeyKst(new Date(scheduledAt || Date.now())));
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND ${LIVE_POST_STATUS_SQL} AND ((video_url IS NOT NULL AND video_url<>'') OR image_url LIKE '%VIDEO%')`
      )
      .get(accountId, start, end)?.c || 0
  );
}
function videoPostsOnDay(accountId, scheduledAt) {
  const day = dayKeyKst(new Date(scheduledAt || Date.now()));
  return videoPostsOnDayFromDb(accountId, scheduledAt) + inflightCount(accountId, day, 'video');
}
// May this slot use a video re-uploaded from another creator? Owner accounts: only while the day
// holds fewer than maxVideoPerDay such posts (about a third). Always true for other accounts.
function videoAllowed(accountId, scheduledAt) {
  if (!isPersonaAccount(accountId)) return true;
  return videoPostsOnDay(accountId, scheduledAt) < accountPersonaSettings().maxVideoPerDay;
}
// Last check right before the INSERT (runs inside the same synchronous transaction as the insert, so a
// second process or a concurrent generation cannot slip in between). `own` lists this slot's own
// reservations (they are not counted against it). Returns { daily, video } over-cap reasons or null.
function capRecheck(accountId, scheduledAt, { daily = false, video = false, own = [] } = {}) {
  if (!isPersonaAccount(accountId)) return { daily: null, video: null };
  const day = dayKeyKst(new Date(scheduledAt || Date.now()));
  const ownCount = kind => own.filter(r => r && r.active && r.kind === kind).length;
  const out = { daily: null, video: null };
  if (daily) {
    const n = dayMixFromDb(accountId, day).daily + inflightCount(accountId, day, 'daily') - ownCount('daily');
    const max = maxDailyFor(accountId);
    if (n >= max) out.daily = `일상 글 하루 한도 ${n}/${max} (insert 직전 재확인)`;
  }
  if (video) {
    const n = videoPostsOnDayFromDb(accountId, scheduledAt) + inflightCount(accountId, day, 'video') - ownCount('video');
    const max = accountPersonaSettings().maxVideoPerDay;
    if (n >= max) out.video = `영상 하루 한도 ${n}/${max} (insert 직전 재확인)`;
  }
  return out;
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
// 2026-11-05 (dev 936a5d23): a product whose Coupang deeplink conversion is refused ("url convert failed") is
// remembered for 7 days and skipped, so the next attempt picks another product instead of posting a plain URL
// (plain URLs failed as Threads comments with subcode 4279047 and earn no Partners commission).
const LINK_REJECT_TTL_MS = 7 * 86400000;
const linkRejected = new Map();
function linkRejectKeys(product) {
  const keys = [];
  if (product?.productId) keys.push('p:' + String(product.productId));
  const url = String(product?.url || '').split(/[?#]/)[0].toLowerCase();
  if (url) keys.push('u:' + url);
  return keys;
}
function markLinkRejected(product, now = Date.now()) {
  for (const k of linkRejectKeys(product)) linkRejected.set(k, now + LINK_REJECT_TTL_MS);
}
function isLinkRejected(product, now = Date.now()) {
  return linkRejectKeys(product).some((k) => {
    const until = linkRejected.get(k);
    if (!until) return false;
    if (until < now) {
      linkRejected.delete(k);
      return false;
    }
    return true;
  });
}
function linkRejectFilter(candidate) {
  return isLinkRejected(candidate?.product) ? '쿠팡 딥링크 변환 거부된 상품' : null;
}

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
      const rejected = linkRejectFilter(candidate);
      if (rejected) return rejected;
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
  dailySlotMinuteFor,
  linkFreeAllowed,
  dayMix,
  slotKind,
  videoPostsOnDay,
  videoAllowed,
  reserveSlot,
  capRecheck,
  dedupeKeysFor,
  encodeKeys,
  decodeKeys,
  findDuplicate,
  textSimilarity,
  findSimilarText,
  SIMILAR_TEXT_THRESHOLD,
  generationFilters,
  markLinkRejected,
  isLinkRejected,
  linkRejectFilter,
  frameCounts,
  chooseFrameFor,
  duplicateError,
};
