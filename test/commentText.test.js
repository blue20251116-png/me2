'use strict';
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// accountMix (linkFreeAllowed test) opens SQLite: use a throwaway data dir, never the live db/.
if (!process.env.ME2_DATA_DIR) process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-comment-'));
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

// 2026-10-21: every product post carries its Coupang Partners link in the documented comment layout.
test('product comment: one-liner, up to 3 ✅ points, "내가 본 건 이거👇" + link, [광고] disclosure', async () => {
  const { buildCommentText } = require('../src/publish/commentText');
  const account = { id: 1, coupang_access_key: 'a', coupang_secret_key: 'b' };
  const out = await buildCommentText(account, {
    link: 'https://link.coupang.com/a/abc',
    recipe_comment_text: '헤드가 쏙 분리돼서 세척이 편함\n스텐이라 녹 걱정 없음\n✅ 손잡이가 안 미끄러움\n접어서 보관됨\n다섯 번째 줄',
    content_mode: 'product',
  });
  const lines = out.split('\n');
  assert.equal(lines[0], '헤드가 쏙 분리돼서 세척이 편함');
  assert.deepEqual(
    lines.filter(l => l.startsWith('✅ ')),
    ['✅ 스텐이라 녹 걱정 없음', '✅ 손잡이가 안 미끄러움', '✅ 접어서 보관됨']
  );
  assert.match(out, /내가 본 건 이거👇\nhttps:\/\/link\.coupang\.com\/a\/abc/);
  assert.match(out, /\[광고\] 이 포스팅은 쿠팡 파트너스 활동의 일환으로/);
  assert.equal([...out.matchAll(/https?:\/\//g)].length, 1);
  // Without points it is still one-liner + link + disclosure.
  const short = await buildCommentText(account, {
    link: 'https://link.coupang.com/a/abc',
    recipe_comment_text: '',
    content_mode: 'product',
  });
  assert.match(short, /^내가 본 건 이거👇\nhttps:\/\/link\.coupang\.com\/a\/abc\n\n\[광고\]/);
});

test('recipe comments never get the product template', async () => {
  const { buildCommentText } = require('../src/publish/commentText');
  const out = await buildCommentText(
    { id: 1 },
    {
      link: 'https://link.coupang.com/a/abc',
      recipe_comment_text: '🥘 재료\n- 연근 1개\n\n🍳 만드는 법\n1. 볶는다',
      content_mode: 'recipe',
    }
  );
  assert.doesNotMatch(out, /✅|내가 본 건/);
  assert.match(out, /쿠팡 파트너스 활동의 일환/);
});

test('the published reply keeps ✅ and 👇 but still strips every other emoji', () => {
  const { text } = prepareReplyLinks('한마디😊\n\n✅ 포인트\n\n내가 본 건 이거👇\nhttps://link.coupang.com/a/abc', 'bare');
  assert.equal(text, '한마디\n\n✅ 포인트\n\n내가 본 건 이거👇\nlink.coupang.com/a/abc');
  const { sanitizePublishedThreadsText } = require('../src/threads/publishText');
  assert.equal(sanitizePublishedThreadsText('본문✅👇😊'), '본문');
});

test('a product post is never link-free; only a recipe may be (accountMix.linkFreeAllowed)', () => {
  const { linkFreeAllowed } = require('../src/autopilot/accountMix');
  assert.equal(linkFreeAllowed('unlinked', 'product'), false);
  assert.equal(linkFreeAllowed('linked', 'product'), false);
  assert.equal(linkFreeAllowed('unlinked', 'recipe'), true);
  assert.equal(linkFreeAllowed('linked', 'recipe'), false);
  assert.equal(linkFreeAllowed(null, 'product'), false);
});
