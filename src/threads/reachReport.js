'use strict';
// "What actually gets views" report for one account: this period vs the previous one, and which
// persona, posting hour and topic tag performed best. Posts younger than MIN_AGE_HOURS are left
// out of both periods so a post still collecting views doesn't skew the comparison.
const { db } = require('../infra/db');
const { PERSONAS } = require('../content/personas');
const { pickTopicTag } = require('./topicTag');

const MIN_AGE_HOURS = 24;
const PERSONA_NAMES = Object.fromEntries(PERSONAS.map(p => [p.id, p.name]));

function summarize(rows) {
  const posts = rows.length;
  const sum = key => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  const views = sum('views');
  const replies = sum('replies');
  return {
    posts,
    totalViews: views,
    avgViews: posts ? Math.round(views / posts) : 0,
    avgReplies: posts ? Math.round((replies / posts) * 10) / 10 : 0,
  };
}

function groupBy(rows, keyFn, labelFn = k => k) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: labelFn(key), ...summarize(list) }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

const kstHour = iso => (new Date(iso).getUTCHours() + 9) % 24;

function postsBetween(accountId, fromMs, toMs) {
  return db
    .prepare(
      `SELECT p.id, p.text, p.persona, p.posted_at, COALESCE(i.views,0) AS views, COALESCE(i.replies,0) AS replies
       FROM posts p LEFT JOIN insights i ON i.post_id = p.id
       WHERE p.account_id = ? AND p.status = 'posted' AND p.posted_at >= ? AND p.posted_at < ?`
    )
    .all(accountId, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
}

function buildReachReport(accountId, { now = Date.now(), days = 14 } = {}) {
  const end = now - MIN_AGE_HOURS * 3600000;
  const span = days * 86400000;
  const current = postsBetween(accountId, end - span, end);
  const previous = postsBetween(accountId, end - 2 * span, end - span);
  return {
    days,
    minAgeHours: MIN_AGE_HOURS,
    current: summarize(current),
    previous: summarize(previous),
    byPersona: groupBy(
      current,
      r => r.persona || 'manual',
      k => (k === 'manual' ? '직접 작성/기록 없음' : PERSONA_NAMES[k] || k)
    ),
    byHour: groupBy(
      current,
      r => kstHour(r.posted_at),
      h => `${h}시`
    ),
    byTopic: groupBy(
      current,
      r => pickTopicTag(r.text) || 'none',
      k => (k === 'none' ? '태그 없음' : k)
    ),
  };
}

module.exports = { buildReachReport, MIN_AGE_HOURS };
