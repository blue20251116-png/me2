'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePublishedThreadsText, applyCoupangReplyPreviewGuard } = require('./threadsApi');

test('sanitizePublishedThreadsText strips a lone trailing sentence period', () => {
  assert.equal(sanitizePublishedThreadsText('이거 실화냐.'), '이거 실화냐');
  assert.equal(sanitizePublishedThreadsText('문장하나. 문장둘.'), '문장하나 문장둘');
});

test('sanitizePublishedThreadsText preserves decimal points', () => {
  assert.equal(sanitizePublishedThreadsText('가격 1.5만원인데'), '가격 1.5만원인데');
});

test('sanitizePublishedThreadsText preserves ellipses fully, trailing or mid-text', () => {
  // Regression: the previous regex consumed a period from the preceding
  // capture group on each global-flag advance, so a run of 2+ dots always
  // lost exactly one dot (e.g. "완전 신기함..." -> "완전 신기함.."). This
  // directly fought voiceGuide()'s own rule that ellipses are a natural,
  // encouraged part of the persona's voice.
  assert.equal(sanitizePublishedThreadsText('완전 신기함...'), '완전 신기함...');
  assert.equal(sanitizePublishedThreadsText('진짜 이건 미쳤다....'), '진짜 이건 미쳤다....');
  assert.equal(sanitizePublishedThreadsText('말줄임... 근데 진짜'), '말줄임... 근데 진짜');
});

test('sanitizePublishedThreadsText trims trailing whitespace-newline runs', () => {
  assert.equal(sanitizePublishedThreadsText('와 대박.\n진짜임'), '와 대박\n진짜임');
});

test('applyCoupangReplyPreviewGuard suppresses the preview for any single URL, not just link.coupang.com', () => {
  // Regression: the guard only matched the link.coupang.com domain, but
  // scheduler.js's makeAffiliateLink() can put a plain www.coupang.com product
  // URL in the comment instead - when the account has no working Coupang
  // Partners deeplink credentials (createDeeplink() passes the original URL
  // through unchanged), or when classifyCoupangUrl()'s lptag/subid/aff query
  // heuristic already treats a plain coupang.com URL as "already affiliate"
  // and returns it as-is. In either case the old regex found zero matches and
  // silently skipped suppression entirely, so Threads' normal single-URL
  // auto-preview card showed up on the comment untouched.
  const cases = [
    'https://link.coupang.com/a/abc123',
    'https://www.coupang.com/vp/products/12345?itemId=1&vendorItemId=2',
    'https://www.coupang.com/vp/products/12345?aff=someid',
  ];
  for (const url of cases) {
    const result = applyCoupangReplyPreviewGuard(`이 상품 진짜 좋아요\n${url}`);
    assert.equal(result.guardApplied, true, `guard should apply for: ${url}`);
    assert.equal(result.urlCount, 2, `must end up with 2 URLs for: ${url}`);
    assert.ok(result.text.includes(url), 'the original URL must be preserved untouched');
  }
});

test('applyCoupangReplyPreviewGuard leaves text with no URL, or already 2+ URLs, alone', () => {
  const noUrl = applyCoupangReplyPreviewGuard('그냥 텍스트 댓글');
  assert.equal(noUrl.guardApplied, false);
  assert.equal(noUrl.urlCount, 0);
  assert.equal(noUrl.text, '그냥 텍스트 댓글');

  const alreadyTwo = applyCoupangReplyPreviewGuard('https://a.com/1\nhttps://b.com/2');
  assert.equal(alreadyTwo.guardApplied, false);
  assert.equal(alreadyTwo.urlCount, 2);
});
