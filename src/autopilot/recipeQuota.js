'use strict';
// 2026-11-13 (AI company dev aad7afc8, marketing 6fd0e425): threads__market (account 10) recipe posts did best
// (11/11 air-fryer recipes 3,514 / 1,241 / 760 views) but 11/12 had none: recipe or product only followed the material.
// accountPersonas.json may now set, per account,
//   "minRecipePerDayByAccount": {"10": 3}             recipe posts wanted each KST day
//   "recipeKeywordsByAccount": {"10": ["에어프라이어", "통째로"]}  materials with these words are tried first
//   "recipeEveningHours": [20, 22]                    KST hours whose slots take only a recipe while the day is short
// While the day is short, the material engine prefers recipe materials; in an evening slot (or when the deficit is as
// big as the slots left) it skips non-recipe materials unless nothing else is left.
const fs = require('fs');
const path = require('path');
const { db } = require('../infra/db');
const { dayKeyKst, dayBounds, LIVE_POST_STATUS_SQL } = require('../publish/slots');

const CONFIG_PATH = () => (process.env.ME2_ACCOUNT_PERSONAS_FILE
  ? path.resolve(process.env.ME2_ACCOUNT_PERSONAS_FILE)
  : path.join(__dirname, '..', 'config', 'accountPersonas.json'));

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')); } catch { return {}; }
}

function recipeCountOnDay(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  const row = db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND content_mode='recipe' AND scheduled_at>=? AND scheduled_at<? AND ${LIVE_POST_STATUS_SQL}`).get(accountId, start, end);
  return Number(row?.c || 0);
}

const kstHour = (at) => (new Date(at).getUTCHours() + 9) % 24;

// -> null (no rule for this account) or { min, count, deficit, keywords, strict }
function recipeQuotaFor(accountId, scheduledAt, { config = readConfig(), count = recipeCountOnDay, slotsLeft = null } = {}) {
  const id = String(Number(accountId));
  const min = Number(config.minRecipePerDayByAccount?.[id]) || 0;
  if (!(min > 0) || !scheduledAt) return null;
  const done = count(Number(id), dayKeyKst(new Date(scheduledAt)));
  const deficit = Math.max(0, min - done);
  const evening = (Array.isArray(config.recipeEveningHours) ? config.recipeEveningHours : [20, 22]).map(Number).includes(kstHour(scheduledAt));
  const keywords = (config.recipeKeywordsByAccount?.[id] || []).map(String).filter(Boolean);
  return { min, count: done, deficit, keywords, strict: deficit > 0 && (evening || (slotsLeft != null && slotsLeft <= deficit)) };
}

function looksLikeRecipe(material, keywords = [], localMode = null) {
  const t = `${material?.sourceText || material?.text || ''}\n${material?.authorReplies || ''}`;
  return localMode === 'recipe' || keywords.some((k) => t.includes(k));
}

// Recipe-looking materials first (stable order otherwise).
function recipeFirst(materials = [], keywords = [], localModeOf = () => null) {
  const score = (m) => (looksLikeRecipe(m, keywords, localModeOf(m)) ? 0 : 1);
  return materials.map((m, i) => [m, i]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(([m]) => m);
}

module.exports = { recipeQuotaFor, recipeFirst, looksLikeRecipe, recipeCountOnDay, readConfig };
