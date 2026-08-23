'use strict';

const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { db, getAccount, getSystemApiSettings } = require('./db');

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

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const system = getSystemApiSettings();
  return system.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
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
  let exclamationPosts = 0;
  let questionPosts = 0;
  let reactionPosts = 0;

  for (const row of ranked) {
    const lines = row.text.split('\n').map((x) => x.trim()).filter(Boolean);
    lineCounts.push(lines.length);
    lineLengths.push(...lines.map((x) => x.length));
    if (/ㅋㅋ|ㅎㅎ/.test(row.text)) laughPosts += 1;
    if (/!/.test(row.text)) exclamationPosts += 1;
    if (/\?/.test(row.text)) questionPosts += 1;
    if (/(?:ㅋㅋ|ㅎㅎ|;;|ㄷㄷ|헐|와\b|아니\b|미쳤|개맛|뭐야)/.test(row.text)) reactionPosts += 1;
  }

  const pct = (n) => Math.round((n / ranked.length) * 100);
  return {
    examples: ranked.slice(0, 7).map((row) => row.text),
    stats: {
      posts: ranked.length,
      medianLines: Math.max(1, Math.round(median(lineCounts))),
      medianLineLength: Math.max(1, Math.round(median(lineLengths))),
      laughPct: pct(laughPosts),
      exclamationPct: pct(exclamationPosts),
      questionPct: pct(questionPosts),
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

function systemPrompt(profile) {
  const s = profile.stats;
  const examples = profile.examples.map((text, i) => `[성과 상위 예시 ${i + 1}]\n${text}`).join('\n\n');
  return `너는 한국 Threads 본문 스타일 편집기다

목표는 새로운 사실을 만드는 것이 아니라 현재 글의 사실과 의미를 그대로 유지하면서 이 계정에서 실제 반응이 좋았던 글의 리듬을 재현하는 것이다

[이 계정 실측 스타일]
- 성과 상위 표본 ${s.posts}개 기반
- 본문 중앙값 약 ${s.medianLines}줄
- 한 줄 길이 중앙값 약 ${s.medianLineLength}자
- ㅋㅋ/ㅎㅎ 포함 비율 약 ${s.laughPct}%
- 느낌표 포함 비율 약 ${s.exclamationPct}%
- 물음표 포함 비율 약 ${s.questionPct}%
- 즉각적 반응 표현 포함 비율 약 ${s.reactionPct}%

[절대 규칙]
- 예시의 제품명 재료명 사건 내용은 새 글에 가져오지 않는다
- 예시 문장을 그대로 복사하지 않는다
- 예시에서 12자 이상 연속된 표현을 그대로 재사용하지 않는다
- 입력에 없는 구매 경험 사용 경험 주변인 반응 수치 효능을 만들지 않는다
- 마침표와 쉼표를 쓰지 않는다
- 존댓말 금지
- ~냐 금지
- 음슴체 금지
- ~더라 ~더라고 계열 금지
- 광고 카피 블로그 후기처럼 정리하지 않는다
- 핵심 상품명 재료명 사실 관계는 바꾸지 않는다
- 댓글 링크 대가성 문구를 새로 만들지 않는다
- 지금 글이 이미 자연스러우면 억지로 바꾸지 않는다

[성과 상위 글 스타일 참고]
${examples}

출력은 JSON만
{"text":""}`;
}

async function rewriteWithProfile(accountId, currentText, profile) {
  const key = getOpenAIKey(accountId);
  if (!key) return currentText;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.82,
      max_tokens: 650,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(profile) },
        {
          role: 'user',
          content: `[현재 작성된 본문]\n${currentText}\n\n위 글의 사실은 그대로 보존하고 이 계정의 성과 상위 글과 비슷한 리듬으로만 다듬어라`
        }
      ]
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      timeout: 30000
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return clean(parsed.text || currentText);
}

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  if (String(process.env.THREADS_STYLE_PROFILE_ENABLED || '1') === '0') return result;

  const current = clean(result.text);
  let profile;
  try {
    profile = getStyleProfile(accountId);
  } catch (error) {
    console.warn(`[AutopilotV3][STYLE PROFILE] corpus skipped error=${error.message}`);
    return { ...result, text: current };
  }

  if (!profile) {
    console.log('[AutopilotV3][STYLE PROFILE] skip insufficient-history');
    return { ...result, text: current };
  }

  try {
    const rewritten = await rewriteWithProfile(accountId, current, profile);
    if (!rewritten) return { ...result, text: current };
    console.log(`[AutopilotV3][STYLE PROFILE] applied lines=${profile.stats.medianLines} reaction=${profile.stats.reactionPct}% preview="${rewritten.slice(0, 160).replace(/\n/g, ' / ')}"`);
    return { ...result, text: rewritten };
  } catch (error) {
    console.warn(`[AutopilotV3][STYLE PROFILE] rewrite skipped error=${error.response?.data?.error?.message || error.message}`);
    return { ...result, text: current };
  }
};

module.exports = { buildProfile, getStyleProfile, clean };
