'use strict';
// One-source multi-use: turns a finished Korean Threads post into a 2-3 tweet English thread for
// a US audience. Runs AFTER the Threads post is saved and never throws into the Threads pipeline.
const { getAccount, getSystemApiSettings } = require('../infra/db');
const { callAIJson } = require('../integrations/aiClient');
const { finalizeThread, pickCta, TWEET_LIMIT } = require('./xText');
const { saveDraft } = require('./xDrafts');

const ENABLED = () => process.env.X_TRACK_ENABLED === '1';
const CTA_TARGET = () => (process.env.X_CTA_TARGET === 'bio' ? 'bio' : 'pinned');

function getAiKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.anthropic_api_key || process.env.ANTHROPIC_API_KEY || account?.anthropic_api_key || null;
}

const SYSTEM = `You are a native US-English X (Twitter) creator who turns everyday finds and home-cooking ideas into short viral threads.
Return ONLY JSON: {"tweets":["...","..."]}
Rules:
- 2 or 3 tweets. Each tweet under 220 characters. Plain English a US reader would actually write.
- Tweet 1 is the hook: a relatable situation or a surprising detail, no clickbait lies.
- Keep the same core idea as the Korean source, but localize it for US readers. Do NOT translate word for word.
- NEVER include URLs, web addresses, domains, @mentions, hashtags, prices in won, or the names Coupang/Naver.
- Do not name brands or products; refer to the item by what it does.
- No health, weight-loss or medical claims. No invented numbers, reviews, or "my husband said" quotes.
- No call to action and no "link below" - the system adds the closing line itself.`;

async function generateXThread(accountId, { text, topic, mode }) {
  const apiKey = getAiKey(accountId);
  const user = `Content type: ${mode || 'post'}\nTopic: ${topic || '-'}\nKorean source post:\n${String(text || '').slice(0, 1500)}`;
  const out = await callAIJson(apiKey, { system: SYSTEM, userContent: user, maxTokens: 500, temperature: 0.8 });
  const target = CTA_TARGET();
  const { tweets, removedUrls } = finalizeThread(out?.tweets, { cta: pickCta(target), limit: TWEET_LIMIT });
  return { tweets, removedUrls, ctaTarget: target };
}

// Fire-and-forget hook called right after saveAutopilotPost(). Errors are logged, never rethrown.
function queueXCompanion(postId, accountId, source) {
  if (!ENABLED() || !postId) return;
  generateXThread(accountId, source)
    .then(({ tweets, removedUrls, ctaTarget }) => {
      saveDraft({ postId, accountId, tweets, ctaTarget });
      console.log(
        `[XTrack][DRAFT] post #${postId} account #${accountId} tweets=${tweets.length} removedUrls=${removedUrls}`
      );
    })
    .catch(err => console.warn(`[XTrack][DRAFT] post #${postId} 생성 실패 (Threads 발행은 영향 없음): ${err.message}`));
}

module.exports = { generateXThread, queueXCompanion, SYSTEM };
