'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDoubleLinkComment } = require('./scheduler');
const { applyCoupangReplyPreviewGuard } = require('./threadsApi');

test('buildDoubleLinkComment uses a differentiated second URL, not a literal duplicate', () => {
  // Regression: this used to repeat the exact same URL string twice ([l, l, disclosure]) to make
  // Threads see "2 URLs" and skip its single-link auto-preview card. That is an independently-
  // written duplicate of the same idea threadsApi.js's applyCoupangReplyPreviewGuard() already
  // implements with a differentiated #fragment variant instead of a literal repeat - two copies
  // of the same trick that can drift apart, exactly like this one did (an identical duplicate may
  // still read as "one link" to Threads' crawler, which the fragment-variant approach avoids).
  const link = 'https://link.coupang.com/a/abc123';
  const comment = buildDoubleLinkComment({}, '이 상품 진짜 좋아요', link, 450);
  const urls = [...comment.matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
  assert.equal(urls.length, 2, 'must contain exactly 2 URL occurrences');
  assert.ok(urls.includes(link), 'the original link must appear untouched');
  assert.notEqual(urls[0], urls[1], 'the two URLs must not be a literal identical duplicate');
});

test('buildDoubleLinkComment output composes correctly with applyCoupangReplyPreviewGuard downstream', () => {
  // publishReply() always runs applyCoupangReplyPreviewGuard() on whatever text it receives -
  // confirm the two URLs this function already produces are recognized as "already handled"
  // (guardApplied: false) rather than the guard trying to add a third URL on top.
  const link = 'https://link.coupang.com/a/abc123';
  const comment = buildDoubleLinkComment({}, '이 상품 진짜 좋아요', link, 450);
  const result = applyCoupangReplyPreviewGuard(comment);
  assert.equal(result.guardApplied, false);
  assert.equal(result.urlCount, 2);
  const urls = [...result.text.matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
  assert.equal(urls.length, 2, 'the guard must not add a third URL on top of the 2 already present');
});

test('buildDoubleLinkComment includes the Coupang disclosure and stays within the length cap', () => {
  const link = 'https://link.coupang.com/a/abc123';
  const comment = buildDoubleLinkComment({}, '이 상품 진짜 좋아요', link, 450);
  assert.match(comment, /쿠팡\s*파트너스\s*활동의\s*일환/);
  assert.ok(comment.length <= 450, `comment must respect the cap: ${comment.length}`);
});

test('buildDoubleLinkComment throws when there is no link to build a comment around', () => {
  assert.throws(() => buildDoubleLinkComment({}, '이 상품 진짜 좋아요', '', 450));
});
