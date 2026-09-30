'use strict';
// Per-account performance of each writing persona, from this account's own published posts.
// Only posts at least MIN_AGE_HOURS old count, so a post still gathering views doesn't drag its
// persona down.
const { db } = require('../infra/db');

const WINDOW_DAYS = 30;
const MIN_AGE_HOURS = 24;

// Reach is the goal, and replies are what Threads rewards most, so one reply is worth 30 views.
function engagementScore({ avgViews, avgReplies }) {
  return avgViews + 30 * avgReplies;
}

function personaScores(accountId, { now = Date.now(), days = WINDOW_DAYS, minAgeHours = MIN_AGE_HOURS } = {}) {
  if (!accountId) return {};
  const from = new Date(now - days * 86400000).toISOString();
  const to = new Date(now - minAgeHours * 3600000).toISOString();
  const rows = db
    .prepare(
      `SELECT p.persona AS persona, COUNT(*) AS posts, AVG(COALESCE(i.views,0)) AS avgViews, AVG(COALESCE(i.replies,0)) AS avgReplies
       FROM posts p LEFT JOIN insights i ON i.post_id = p.id
       WHERE p.account_id = ? AND p.status = 'posted' AND p.persona IS NOT NULL AND p.posted_at >= ? AND p.posted_at <= ?
       GROUP BY p.persona`
    )
    .all(accountId, from, to);
  const out = {};
  for (const r of rows) {
    const stats = { posts: Number(r.posts), avgViews: Number(r.avgViews) || 0, avgReplies: Number(r.avgReplies) || 0 };
    out[r.persona] = { ...stats, score: engagementScore(stats) };
  }
  return out;
}

module.exports = { personaScores, engagementScore, WINDOW_DAYS, MIN_AGE_HOURS };
