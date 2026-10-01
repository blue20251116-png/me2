'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLinkComment } = require('../src/publish/commentText');
const { prepareReplyLinks } = require('../src/threads/publishText');

test('buildLinkComment carries the link exactly once (no duplicate-link preview trick)', () => {
  const link = 'https://link.coupang.com/a/abc123';
  const comment = buildLinkComment({}, '이 상품 진짜 좋아요', link, 450);
  const urls = [...comment.matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
  assert.deepEqual(urls, [link]);
  assert.doesNotMatch(comment, /preview2/);
});

test('the published reply shows the link without a scheme, so Threads draws no preview card', () => {
  const comment = buildLinkComment({}, '이 상품 진짜 좋아요', 'https://link.coupang.com/a/abc123', 450);
  const { text, linkCount } = prepareReplyLinks(comment, 'bare');
  assert.equal(linkCount, 1);
  assert.match(text, /^link\.coupang\.com\/a\/abc123$/m);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('buildLinkComment includes the Coupang disclosure and stays within the length cap', () => {
  const link = 'https://link.coupang.com/a/abc123';
  const comment = buildLinkComment({}, '이 상품 진짜 좋아요', link, 450);
  assert.match(comment, /쿠팡\s*파트너스\s*활동의\s*일환/);
  assert.ok(comment.length <= 450, `comment must respect the cap: ${comment.length}`);
});

test('buildLinkComment throws when there is no link to build a comment around', () => {
  assert.throws(() => buildLinkComment({}, '이 상품 진짜 좋아요', '', 450));
});
