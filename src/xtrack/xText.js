'use strict';
// Pure text rules for the X (Twitter) companion track. No I/O here so every rule is unit-testable.
//
// Why "no URL, ever" is a hard rule (2026-10-15, user request): under X API pay-per-use, a post
// created through the API whose text contains a URL is billed at the link rate (reported as
// $0.20/post since 2026-04-20) instead of the plain-post rate (reported as $0.015/post). Replies
// in a thread are posts too, so a link in ANY tweet of the thread triggers it. Traffic is routed
// to the profile's pinned post / bio with a plain-text CTA instead.

const TWEET_LIMIT = 260; // user rule: each tweet ≤ 260 (X's hard limit is 280 weighted)

// X weighted length: most Latin/CJK-adjacent punctuation ranges count 1, everything else 2.
// Mirrors twitter-text's default config ranges closely enough for a safety margin of 20.
function xWeightedLength(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    const light = c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

// Anything X would auto-link (scheme URLs, www., bare domains on common TLDs, t.co/bit.ly style).
const URL_RE =
  /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|ly|gg|app|dev|me|tv|us|xyz|link|site|shop|store|kr|gl|to|info|biz)\b(?:\/\S*)?)/gi;

function hasUrl(text) {
  URL_RE.lastIndex = 0;
  return URL_RE.test(String(text || ''));
}

function stripUrls(text) {
  return String(text || '')
    .replace(URL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CTA_VARIANTS = {
  pinned: [
    'The full breakdown is in my pinned post.',
    'More on this in my pinned post 👆',
    'Check my pinned post for the rest.',
  ],
  bio: ['Everything I use is in my bio.', 'The full list is in my bio.', 'Details are in my bio.'],
};

function pickCta(target = 'pinned', seed = Math.random()) {
  const list = CTA_VARIANTS[target] || CTA_VARIANTS.pinned;
  return list[Math.floor(seed * list.length) % list.length];
}

// Trim to fit `limit` weighted chars at a sentence/word boundary, never mid-word.
function fitToLimit(text, limit) {
  let t = String(text || '').trim();
  if (xWeightedLength(t) <= limit) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && xWeightedLength(sentences.join(' ')) > limit) sentences.pop();
  t = sentences.join(' ');
  if (xWeightedLength(t) <= limit) return t;
  const words = t.split(/\s+/);
  while (words.length > 1 && xWeightedLength(words.join(' ') + '…') > limit) words.pop();
  return words.join(' ') + '…';
}

// Final enforcement: strip links, drop empties, cap tweet count, append CTA to the last tweet,
// keep every tweet ≤ limit. Returns { tweets, removedUrls }.
function finalizeThread(rawTweets, { cta, limit = TWEET_LIMIT, min = 2, max = 3 } = {}) {
  let removedUrls = 0;
  let tweets = (Array.isArray(rawTweets) ? rawTweets : [])
    .map(t => {
      const s = String(t || '');
      if (hasUrl(s)) removedUrls++;
      return stripUrls(s).replace(/#\w+/g, '').trim();
    })
    .filter(Boolean)
    .slice(0, max);
  if (tweets.length < min) {
    const err = new Error(`X thread too short (${tweets.length} tweets)`);
    err.code = 'X_THREAD_TOO_SHORT';
    throw err;
  }
  const ctaLine = String(cta || '').trim();
  tweets = tweets.map((t, i) => {
    const isLast = i === tweets.length - 1;
    if (!isLast || !ctaLine) return fitToLimit(t, limit);
    const room = limit - xWeightedLength(ctaLine) - 2;
    return `${fitToLimit(t, room)}\n\n${ctaLine}`;
  });
  if (tweets.some(hasUrl)) {
    const err = new Error('URL survived sanitizing - refusing to save X thread');
    err.code = 'X_URL_GUARD';
    throw err;
  }
  return { tweets, removedUrls };
}

module.exports = { TWEET_LIMIT, xWeightedLength, hasUrl, stripUrls, pickCta, fitToLimit, finalizeThread };
