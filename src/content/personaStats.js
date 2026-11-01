'use strict';
// Per-account performance of each writing persona, from this account's own published posts.
// Only posts at least MIN_AGE_HOURS old count, so a post still gathering views doesn't drag its
// persona down.
const { db } = require('../infra/db');

const WINDOW_DAYS = 30;
const MIN_AGE_HOURS = 6;
const TARGET_VIEWS = 1000;

// Narrative angles rotated when an account's recent posts are under TARGET_VIEWS (1,000 views),
// modeled on the posts in scheduler.db that actually crossed 1,000–39,000 views.
const PERSONA_ANGLES = [
  {
    id: 'episode-twist',
    name: '주변 인물 기행·사건 반전형',
    guide:
      '첫 줄을 물건/요리 설명이 아니라 가족·지인·주변 사람의 기묘하거나 의아한 행동 한 장면으로 시작한다(원문 근거 범위 내). "도대체 왜 저러나 싶었는데 알고 보니…" 흐름으로 중반에 정체를 드러낸다.',
  },
  {
    id: 'skeptic-convert',
    name: '불신·반신반의 → 결과 실증형',
    guide:
      '처음엔 "솔직히 또 광고인 줄 알고 안 믿었음 / 반신반의했음" 하는 의심 시점으로 열고, 직접 겪은 구체적인 변화 한 장면만으로 태도가 바뀐 과정을 담백하게 쓴다.',
  },
  {
    id: 'regret-time',
    name: '진작 알았으면 억울함·시간 손해형',
    guide:
      '그동안 몰라서 손으로 고생하거나 돈·시간을 허비했던 과거 장면을 첫 줄에 먼저 깔고, 바꾼 뒤 얼마나 허무할 정도로 간단해졌는지 대비시킨다.',
  },
  {
    id: 'sensory-closeup',
    name: '현장 한 장면·오감 클로즈업형',
    guide:
      '배경 설명 없이 지금 눈앞의 소리·식감·손동작·반응 한 장면으로 첫 줄을 바로 시작한다. 독자가 첫 줄을 읽자마자 장면이 머릿속에 그려지게 쓴다.',
  },
  {
    id: 'dilemma-debate',
    name: '솔직 고백 + 양자택일 댓글 논쟁형',
    guide:
      '누구나 겪지만 말 안 하던 사소한 불편·습관 고백으로 시작하고, 마지막 줄에 읽는 사람이 "나는 A파 / 나는 B파"로 3초 안에 답글을 달고 싶어지는 구체적인 양자택일 질문을 던진다.',
  },
  {
    id: 'mystery-hold',
    name: '정체 끝까지 숨기기·호기심 견인형',
    guide:
      '첫 줄과 둘째 줄에서 대상이 뭔지 절대 밝히지 않고, 그것 때문에 벌어진 결과나 주변 사람들의 반응만 먼저 보여준 뒤 마지막에 정체를 공개한다.',
  },
  {
    id: 'dry-three-line',
    name: '수식어 뺀 시크·담백 3~4줄 팩트형',
    guide:
      '감탄사·수다를 싹 덜어내고, 시크하고 건조한 말투로 상황 → 핵심 포인트 1개 → 짧은 결론만 3~4줄 안에 툭 던지듯 짧게 끝낸다.',
  },
  {
    id: 'reaction-witness',
    name: '먹어본·써본 사람 현장 리액션 목격형',
    guide:
      '내가 좋다고 설명하는 대신, 옆에서 보거나 함께 겪은 사람의 즉각적인 행동 반응(말없이 두 번 더 가져감, 어디 거냐고 바로 물어봄 등 원문 근거 내)을 주인공으로 세운다.',
  },
];

// Reach is the goal (target: 1,000+ views per post), and replies are what Threads rewards most.
// Personas that actually cross 1,000 views get a strong bonus; personas with >=3 evaluated posts
// that have never reached 1,000 views get penalized so the account keeps exploring better personas.
function engagementScore({ avgViews, avgReplies, over1000Count = 0, posts = 0, maxViews = null }) {
  const base = (Number(avgViews) || 0) + 30 * (Number(avgReplies) || 0);
  const hitBonus = posts > 0 && over1000Count > 0 ? TARGET_VIEWS * (over1000Count / posts) : 0;
  const raw = base + hitBonus;
  if (posts >= 3 && maxViews !== null && Number(maxViews) < TARGET_VIEWS) {
    return raw * 0.25;
  }
  return raw;
}

function personaScores(accountId, { now = Date.now(), days = WINDOW_DAYS, minAgeHours = MIN_AGE_HOURS } = {}) {
  if (!accountId) return {};
  const from = new Date(now - days * 86400000).toISOString();
  const to = new Date(now - minAgeHours * 3600000).toISOString();
  const rows = db
    .prepare(
      `SELECT p.persona AS persona,
              COUNT(*) AS posts,
              AVG(COALESCE(i.views,0)) AS avgViews,
              AVG(COALESCE(i.replies,0)) AS avgReplies,
              MAX(COALESCE(i.views,0)) AS maxViews,
              SUM(CASE WHEN COALESCE(i.views,0) >= ? THEN 1 ELSE 0 END) AS over1000Count
       FROM posts p LEFT JOIN insights i ON i.post_id = p.id
       WHERE p.account_id = ? AND p.status = 'posted' AND p.persona IS NOT NULL AND p.posted_at >= ? AND p.posted_at <= ?
       GROUP BY p.persona`
    )
    .all(TARGET_VIEWS, accountId, from, to);
  const out = {};
  for (const r of rows) {
    const stats = {
      posts: Number(r.posts),
      avgViews: Number(r.avgViews) || 0,
      avgReplies: Number(r.avgReplies) || 0,
      maxViews: Number(r.maxViews) || 0,
      over1000Count: Number(r.over1000Count) || 0,
    };
    out[r.persona] = { ...stats, score: engagementScore(stats) };
  }
  return out;
}

// Most recent persona scheduled or published on this account, so consecutive posts always change persona.
function lastPersonaFor(accountId) {
  if (!accountId) return null;
  try {
    const row = db
      .prepare(
        `SELECT persona FROM posts WHERE account_id = ? AND status IN ('pending', 'posted') AND persona IS NOT NULL AND persona <> '' ORDER BY scheduled_at DESC, id DESC LIMIT 1`
      )
      .get(accountId);
    return row?.persona || null;
  } catch {
    return null;
  }
}

function firstLineOf(text) {
  return (
    String(text || '')
      .split('\n')
      .map(l => l.trim())
      .find(Boolean) || ''
  ).slice(0, 70);
}

// Per-post 1,000-view check for an account: inspects recent published posts (and pending queue)
// to see whether the account's recent posts are failing to reach TARGET_VIEWS (1,000).
// When under 1,000 views, returns the recent low-view personas to exclude and the recent low-view
// openings so the next post deliberately switches persona, voice, and narrative structure.
function personaDiagnostics(accountId, { targetViews = TARGET_VIEWS, limit = 8 } = {}) {
  if (!accountId) {
    return {
      under1000: false,
      lastViews: null,
      lowViewStreak: 0,
      excludePersonas: [],
      recentLowPosts: [],
      winningPersonas: [],
    };
  }
  try {
    const posted = db
      .prepare(
        `SELECT p.id, p.persona, p.text, p.posted_at, COALESCE(i.views, 0) AS views, COALESCE(i.replies, 0) AS replies
         FROM posts p LEFT JOIN insights i ON i.post_id = p.id
         WHERE p.account_id = ? AND p.status = 'posted'
         ORDER BY p.posted_at DESC, p.id DESC LIMIT ?`
      )
      .all(accountId, limit);
    const pending = db
      .prepare(
        `SELECT p.id, p.persona, p.text, p.scheduled_at
         FROM posts p
         WHERE p.account_id = ? AND p.status = 'pending'
         ORDER BY p.scheduled_at DESC, p.id DESC LIMIT 4`
      )
      .all(accountId);

    let lowViewStreak = 0;
    for (const r of posted) {
      if (Number(r.views || 0) < targetViews) lowViewStreak++;
      else break;
    }
    const lastViews = posted.length ? Number(posted[0].views || 0) : null;
    // Under-1000 mode is active whenever the account has no published posts yet or its latest
    // published post is below 1,000 views.
    const under1000 = !posted.length || lastViews < targetViews;

    const excludeSet = new Set();
    const lastP = lastPersonaFor(accountId);
    if (lastP) excludeSet.add(lastP);
    for (const r of pending) {
      if (r.persona) excludeSet.add(r.persona);
    }
    if (under1000) {
      for (const r of posted) {
        if (Number(r.views || 0) < targetViews && r.persona) {
          excludeSet.add(r.persona);
        } else if (Number(r.views || 0) >= targetViews) {
          break;
        }
      }
    }

    const recentLowPosts = posted
      .filter(r => Number(r.views || 0) < targetViews)
      .slice(0, 4)
      .map(r => ({
        id: Number(r.id),
        persona: r.persona || 'default',
        views: Number(r.views || 0),
        opening: firstLineOf(r.text),
      }));

    const winningRows = db
      .prepare(
        `SELECT p.persona, MAX(COALESCE(i.views, 0)) AS maxViews
         FROM posts p JOIN insights i ON i.post_id = p.id
         WHERE p.account_id = ? AND p.status = 'posted' AND p.persona IS NOT NULL AND i.views >= ?
         GROUP BY p.persona
         ORDER BY maxViews DESC`
      )
      .all(accountId, targetViews);
    const winningPersonas = winningRows.map(r => r.persona);

    return {
      under1000,
      lastViews,
      lowViewStreak,
      excludePersonas: [...excludeSet],
      recentLowPosts,
      winningPersonas,
    };
  } catch {
    return {
      under1000: true,
      lastViews: null,
      lowViewStreak: 0,
      excludePersonas: [],
      recentLowPosts: [],
      winningPersonas: [],
    };
  }
}

// Picks a fresh narrative angle that differs from the account's recent posts so consecutive
// sub-1,000-view posts never repeat the same opening/story structure.
function pickPersonaAngle(accountId, { random = Math.random } = {}) {
  let recentCount = 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM posts WHERE account_id = ? AND status IN ('pending', 'posted')`)
      .get(accountId);
    recentCount = Number(row?.c || 0);
  } catch {}
  // Rotate deterministically by post count + account offset, with a small random jitter when needed
  const idx = (Number(accountId || 0) * 3 + recentCount + Math.floor(random() * 2)) % PERSONA_ANGLES.length;
  return PERSONA_ANGLES[idx];
}

function buildPersonaReflectionBlock(diag, angle) {
  if (!diag?.under1000) return '';
  const lowLines = (diag.recentLowPosts || [])
    .filter(p => p.opening)
    .map(p => `- (조회수 ${p.views}회 / 페르소나 ${p.persona}) "${p.opening}"`)
    .join('\n');
  return `
[조회수 ${TARGET_VIEWS}회 미만 페르소나 고민 · 전면 전환 지시]
- 이 계정의 최근 게시물 조회수가 기준(${TARGET_VIEWS}회) 미만이므로(최근 연속 미달 ${diag.lowViewStreak || 1}건), 이전 글들과 말투·도입부·전개 방식을 완전히 다르게 바꿔야 한다.
${lowLines ? `- 아래는 최근 조회수 ${TARGET_VIEWS}회를 넘기지 못한 직전 글들의 첫 줄이다. 이와 비슷한 도입부·문장 호흡·패턴은 절대 반복하지 않는다:\n${lowLines}` : '- 직전 글과 같은 도입부·감탄사·마무리 질문 패턴을 절대 반복하지 않는다.'}
${angle ? `- [이번 글의 새로운 서사 각도 — ${angle.name}] ${angle.guide}` : ''}
- 첫 줄 후킹을 읽자마자 스크롤을 멈추게 만들되, 상투적인 감탄이나 이전 글과 비슷한 오프닝으로 시작하지 말고 위 캐릭터와 새 서사 각도에 맞춰 완전히 새로운 결로 작성한다.`;
}

module.exports = {
  personaScores,
  lastPersonaFor,
  personaDiagnostics,
  pickPersonaAngle,
  buildPersonaReflectionBlock,
  PERSONA_ANGLES,
  engagementScore,
  WINDOW_DAYS,
  MIN_AGE_HOURS,
  TARGET_VIEWS,
};
