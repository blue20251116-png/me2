'use strict';
// Fixed-persona owner accounts only (config/accountPersonas.json): what kind of post each slot gets
// (Coupang-linked product/recipe vs link-free everyday post) and product/topic de-duplication.
// Every function is a no-op for other accounts, so their autopilot behaviour is unchanged.
const { db } = require('../infra/db');
const { dayKeyKst, dayBounds } = require('../publish/slots');
const {
  accountPersonaFor,
  isPersonaAccount,
  personaAccountIds,
  accountPersonaSettings,
} = require('../content/accountPersonas');
const { chooseFrame } = require('../content/postFrames');

// At least half of a day's posts are link-free, and linked ones are capped: a slot is linked only
// while linked < maxLinked AND linked < plain, so a day opens with an everyday post and alternates
// (4 posts → 2+2, 5 posts → 3 plain + 2 linked).
// linkedPerPlain = 0: a linked post only while linked < plain (alternating, plain first).
// linkedPerPlain = N: up to N linked posts per everyday post (e.g. 4 -> L L L L D L L L L D L L D).
function decideSlotKind({ linked = 0, plain = 0, maxLinked = 2, linkedPerPlain = 0 } = {}) {
  if (linked >= maxLinked) return 'daily';
  if (linkedPerPlain > 0) return linked < (plain + 1) * linkedPerPlain ? 'linked' : 'daily';
  return linked < plain ? 'linked' : 'daily';
}

function dayMix(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN link IS NOT NULL AND link<>'' THEN 1 ELSE 0 END) linked, SUM(CASE WHEN link IS NULL OR link='' THEN 1 ELSE 0 END) plain FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`
    )
    .get(accountId, start, end);
  return { linked: Number(row?.linked || 0), plain: Number(row?.plain || 0) };
}

// null for accounts without a fixed persona (caller keeps its original path).
function slotKind(accountId, scheduledAt) {
  if (!isPersonaAccount(accountId)) return null;
  const day = dayKeyKst(new Date(scheduledAt || Date.now()));
  const cfg = accountPersonaSettings();
  return decideSlotKind({ ...dayMix(accountId, day), maxLinked: cfg.maxLinkedPerDay, linkedPerPlain: cfg.linkedPerPlain });
}

function normKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '')
    .slice(0, 40);
}
// Identity of a linked post: Coupang product id, product name, source post URL, topic, search term.
// Any shared key counts as the same product/keyword.
function dedupeKeysFor({ product, sourceUrl, topic, searchTerm } = {}) {
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

// Returns { key, scope, accountId } when this account already used one of the keys within
// dedupeOwnDays (before or after the slot), or another fixed-persona account uses it on the same
// KST day as the slot; otherwise null.
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
  const [start, end] = dayBounds(dayKeyKst(new Date(slotMs)));
  const cross = db
    .prepare(
      `SELECT account_id a, dedupe_keys k FROM posts WHERE account_id IN (${others.map(() => '?').join(',')}) AND dedupe_keys IS NOT NULL AND status IN ('pending','posted') AND scheduled_at>=? AND scheduled_at<?`
    )
    .all(...others, start, end);
  for (const r of cross) {
    const hit = decodeKeys(r.k).find(k => wanted.has(k));
    if (hit) return { key: hit, scope: 'cross', accountId: Number(r.a) };
  }
  return null;
}

// Filters handed to the material engine so a duplicate or off-persona source is skipped before
// any vision/AI work, and a duplicate product before the post is written. {} for other accounts.
function generationFilters(accountId, scheduledAt) {
  const persona = accountPersonaFor(accountId);
  if (!persona) return {};
  return {
    materialFilter(material) {
      const text = `${material?.sourceText || material?.text || ''}\n${material?.authorReplies || ''}`;
      if (persona.skipMaterial && persona.skipMaterial.test(text)) return `persona ${persona.id} 소재 아님`;
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
  const err = new Error(`중복 상품/키워드 (${dup.scope} #${dup.accountId} ${dup.key}) → 이 슬롯 생성 생략`);
  err.code = 'DUPLICATE_TOPIC';
  return err;
}

module.exports = {
  decideSlotKind,
  dayMix,
  slotKind,
  dedupeKeysFor,
  encodeKeys,
  decodeKeys,
  findDuplicate,
  generationFilters,
  frameCounts,
  chooseFrameFor,
  duplicateError,
};
