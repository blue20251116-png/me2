'use strict';

const engine = require('./autopilotMaterialEngine');
const { db } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);
const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scoreRow(row) {
  const views = Number(row.views || 0);
  const likes = Number(row.likes || 0);
  const replies = Number(row.replies || 0);
  const reposts = Number(row.reposts || 0);
  const quotes = Number(row.quotes || 0);
  return Math.log10(Math.max(views, 1) + 10) * 10 + likes * 2 + replies * 4 + reposts * 5 + quotes * 5;
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function buildProfile(rows) {
  const ranked = rows
    .map((row) => ({ ...row, styleScore: scoreRow(row), text: clean(row.text) }))
    .filter((row) => row.text.length >= 10)
    .sort((a, b) => b.styleScore - a.styleScore)
    .slice(0, 12);
  if (ranked.length < 6) return null;

  const lineCounts = [];
  const lineLengths = [];
  let laughPosts = 0;
  let reactionPosts = 0;
  for (const row of ranked) {
    const lines = row.text.split('\n').map((x) => x.trim()).filter(Boolean);
    lineCounts.push(lines.length);
    lineLengths.push(...lines.map((x) => x.length));
    if (/ㅋㅋ|ㅎㅎ/.test(row.text)) laughPosts += 1;
    if (/(?:ㅋㅋ|ㅎㅎ|;;|ㄷㄷ|헐|와\b|아니\b|미쳤|개맛|뭐야)/.test(row.text)) reactionPosts += 1;
  }
  const pct = (n) => Math.round((n / ranked.length) * 100);
  return {
    stats: {
      posts: ranked.length,
      medianLines: Math.max(1, Math.round(median(lineCounts))),
      medianLineLength: Math.max(1, Math.round(median(lineLengths))),
      laughPct: pct(laughPosts),
      reactionPct: pct(reactionPosts)
    }
  };
}

function getStyleProfile(accountId) {
  const now = Date.now();
  const cached = cache.get(accountId);
  if (cached && now - cached.at < CACHE_MS) return cached.profile;

  const rows = db.prepare(`
    SELECT p.text,
           COALESCE(i.views, 0) views,
           COALESCE(i.likes, 0) likes,
           COALESCE(i.replies, 0) replies,
           COALESCE(i.reposts, 0) reposts,
           COALESCE(i.quotes, 0) quotes
      FROM posts p
 LEFT JOIN insights i ON i.post_id = p.id
     WHERE p.account_id = ?
       AND p.status = 'posted'
       AND p.text IS NOT NULL
       AND length(trim(p.text)) >= 10
  ORDER BY COALESCE(p.posted_at, p.created_at) DESC
     LIMIT 80
  `).all(accountId);

  const profile = buildProfile(rows);
  cache.set(accountId, { at: now, profile });
  return profile;
}

function localProfileAdjust(text, profile) {
  const current = clean(text);
  if (!profile || !current) return current;
  const lines = current.split('\n').map((x) => x.trim()).filter(Boolean);
  const targetLines = Math.max(3, Math.min(6, Number(profile.stats?.medianLines || 4)));

  // 문장을 억지로 자르지 않고 줄 수만 과도할 때 뒤쪽을 자연스럽게 합친다.
  while (lines.length > targetLines && lines.length > 3) {
    const last = lines.pop();
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${last}`.trim();
  }
  return lines.join('\n').trim();
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  if (String(process.env.THREADS_STYLE_PROFILE_ENABLED || '1') === '0') return result;

  let profile = null;
  try {
    profile = getStyleProfile(accountId);
  } catch (error) {
    console.warn(`[AutopilotV3][STYLE PROFILE] corpus skipped error=${error.message}`);
  }

  const adjusted = localProfileAdjust(result.text, profile);
  if (profile) {
    console.log(`[AutopilotV3][STYLE PROFILE] local-only lines=${profile.stats.medianLines} reaction=${profile.stats.reactionPct}% preview="${adjusted.slice(0,160).replace(/\n/g,' / ')}"`);
  } else {
    console.log('[AutopilotV3][STYLE PROFILE] local-only skip insufficient-history');
  }
  return { ...result, text: adjusted };
};

console.log('[AutopilotV3][STYLE PROFILE] AI 호출 제거 · 계정 성과 프로필 로컬 적용');

module.exports = { buildProfile, getStyleProfile, clean, localProfileAdjust };
