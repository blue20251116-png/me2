'use strict';
// Optional auto-publisher for X companion threads (text only, OAuth 1.0a user context).
// OFF unless X_AUTO_PUBLISH=1 and all four X_* credentials are set. Without it, drafts are only
// shown in the dashboard (/x-drafts.html) for manual copy-paste.
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron');
const { hasUrl } = require('./xText');
const { dueForPublish, publishedCountSince, markPublished, markFailed } = require('./xDrafts');

const X_POST_URL = 'https://api.x.com/2/tweets';

function creds() {
  const c = {
    consumerKey: process.env.X_API_KEY,
    consumerSecret: process.env.X_API_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_SECRET,
  };
  return Object.values(c).every(Boolean) ? c : null;
}

const pct = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// JSON-body requests sign only the oauth_* params (the body is not form-encoded).
function oauthHeader(
  method,
  url,
  c,
  nonce = crypto.randomBytes(16).toString('hex'),
  ts = Math.floor(Date.now() / 1000)
) {
  const params = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(ts),
    oauth_token: c.token,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(params)
    .sort()
    .map(k => `${pct(k)}=${pct(params[k])}`)
    .join('&');
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');
  const key = `${pct(c.consumerSecret)}&${pct(c.tokenSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.keys(params)
      .sort()
      .map(k => `${pct(k)}="${pct(params[k])}"`)
      .join(', ')
  );
}

async function postTweet(text, replyToId, c) {
  if (hasUrl(text)) {
    const err = new Error('URL guard: tweet contains a link - not sent (link posts bill at the higher rate)');
    err.code = 'X_URL_GUARD';
    throw err;
  }
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
  const res = await axios.post(X_POST_URL, body, {
    headers: { Authorization: oauthHeader('POST', X_POST_URL, c), 'content-type': 'application/json' },
    timeout: 20000,
  });
  return res.data?.data?.id;
}

async function publishDraft(draft, c) {
  const ids = [];
  try {
    for (const t of draft.tweets) ids.push(await postTweet(t, ids[ids.length - 1], c));
    markPublished(draft.id, ids);
    console.log(`[XTrack][PUBLISH] draft #${draft.id} → ${ids.length} tweets`);
  } catch (err) {
    const msg = err?.response?.data?.detail || err?.response?.data?.title || err.message;
    markFailed(draft.id, msg, ids);
    console.warn(`[XTrack][PUBLISH] draft #${draft.id} 실패 posted=${ids.length}: ${msg}`);
    if (Number(err?.response?.status) === 429) throw Object.assign(err, { stopTick: true });
  }
}

function startXPublishJob() {
  if (process.env.X_AUTO_PUBLISH !== '1') return;
  const c = creds();
  if (!c) {
    console.warn(
      '[XTrack][PUBLISH] X_AUTO_PUBLISH=1 이지만 X_API_KEY/SECRET/ACCESS_TOKEN/ACCESS_SECRET 누락 → 자동 발행 꺼짐'
    );
    return;
  }
  const maxPerDay = Math.max(1, Number(process.env.X_MAX_THREADS_PER_DAY) || 6);
  let running = false;
  cron.schedule(
    '*/15 * * * *',
    async () => {
      if (running) return;
      running = true;
      try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const room = maxPerDay - publishedCountSince(since);
        if (room <= 0) return;
        for (const d of dueForPublish(Math.min(room, 2))) await publishDraft(d, c);
      } catch (err) {
        console.warn('[XTrack][PUBLISH] tick stopped:', err.message);
      } finally {
        running = false;
      }
    },
    { timezone: 'Asia/Seoul', noOverlap: true }
  );
  console.log(`[XTrack][PUBLISH] ON maxThreadsPerDay=${maxPerDay} (text-only, URL guard ON)`);
}

module.exports = { startXPublishJob, oauthHeader, postTweet };
