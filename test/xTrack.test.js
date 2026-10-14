'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeThread, hasUrl, xWeightedLength, fitToLimit, pickCta } = require('../src/xtrack/xText');
const { oauthHeader, postTweet } = require('../src/xtrack/xPublisher');

test('hasUrl catches every link shape X would auto-link', () => {
  for (const s of [
    'see https://a.com/x',
    'www.example.org',
    'go to coupang.com now',
    'bit.ly/abc',
    'link.coupang.com/a/1',
  ])
    assert.equal(hasUrl(s), true, s);
  for (const s of ['No links here.', 'It took 2.5 hours', 'e.g. this one', '$NVDA is up'])
    assert.equal(hasUrl(s), false, s);
});

test('finalizeThread strips links, appends CTA to the last tweet only, keeps every tweet <= 260', () => {
  const long = 'This little kitchen trick changed my weeknights. '.repeat(10);
  const { tweets, removedUrls } = finalizeThread(
    ['Hook tweet https://x.co/abc', long, 'Last one. Buy at amazon.com #ad'],
    {
      cta: 'The full breakdown is in my pinned post.',
    }
  );
  assert.equal(removedUrls, 2);
  assert.equal(tweets.length, 3);
  assert.ok(tweets.every(t => !hasUrl(t)));
  assert.ok(tweets.every(t => xWeightedLength(t) <= 260));
  assert.ok(tweets[2].endsWith('The full breakdown is in my pinned post.'));
  assert.ok(!tweets[0].includes('pinned post'));
  assert.ok(!tweets[2].includes('#ad'));
});

test('finalizeThread caps at 3 tweets and refuses fewer than 2', () => {
  assert.equal(finalizeThread(['a', 'b', 'c', 'd'], { cta: 'x' }).tweets.length, 3);
  assert.throws(() => finalizeThread(['only one'], { cta: 'x' }), { code: 'X_THREAD_TOO_SHORT' });
  assert.throws(() => finalizeThread(['https://a.com', 'b'], { cta: 'x' }), { code: 'X_THREAD_TOO_SHORT' });
});

test('fitToLimit trims at a word boundary', () => {
  const t = fitToLimit('one two three four five six seven', 15);
  assert.ok(xWeightedLength(t) <= 15);
  assert.ok(t.endsWith('…'));
});

test('pickCta returns a pinned or bio line', () => {
  assert.match(pickCta('pinned', 0), /pinned/i);
  assert.match(pickCta('bio', 0.9), /bio/i);
});

test('oauthHeader produces a signed OAuth 1.0a header', () => {
  const h = oauthHeader(
    'POST',
    'https://api.x.com/2/tweets',
    { consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts' },
    'nonce',
    1700000000
  );
  assert.match(h, /^OAuth /);
  for (const k of [
    'oauth_consumer_key="ck"',
    'oauth_nonce="nonce"',
    'oauth_signature=',
    'oauth_timestamp="1700000000"',
    'oauth_token="t"',
  ])
    assert.ok(h.includes(k), k);
});

test('postTweet refuses to send a tweet containing a URL', async () => {
  await assert.rejects(postTweet('check https://a.com', null, {}), { code: 'X_URL_GUARD' });
});
