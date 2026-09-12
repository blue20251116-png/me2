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

test('sanitizePublishedThreadsText strips a trailing period stuck to a URL ending in a digit', () => {
  // REGRESSION found via synthetic testing: the sentence-period stripper above deliberately
  // skips periods preceded by a digit (to protect decimal points like "1.5"), but affiliate
  // links very commonly end in a digit ("...abc123") - so a comment ending in "...보러가기
  // https://link.coupang.com/a/abc123." kept the period stuck directly to the URL, producing a
  // broken destination (".../abc123.") once Threads turns it into a real clickable link. Fixed
  // by stripping trailing .,; from URL matches first, same technique scheduler.js's
  // extractFirstHttpUrl already uses for the same reason.
  assert.equal(
    sanitizePublishedThreadsText('이 상품 진짜 좋아요 https://link.coupang.com/a/abc123.'),
    '이 상품 진짜 좋아요 https://link.coupang.com/a/abc123'
  );
  assert.equal(
    sanitizePublishedThreadsText('구매는 여기로! https://link.coupang.com/a/xy9.'),
    '구매는 여기로! https://link.coupang.com/a/xy9'
  );
  // decimal points elsewhere in the same text must still be preserved
  assert.equal(
    sanitizePublishedThreadsText('가격 1.5만원인데 https://link.coupang.com/a/abc123.'),
    '가격 1.5만원인데 https://link.coupang.com/a/abc123'
  );
});

test('applyCoupangReplyPreviewGuard produces a clickable (unbroken) URL even when the source text ends the link with a period', () => {
  const result = applyCoupangReplyPreviewGuard('이 상품 진짜 좋아요 https://link.coupang.com/a/abc123.');
  const urls = [...result.text.matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
  assert.equal(urls.length, 2);
  for (const u of urls) assert.ok(!u.endsWith('.'), `URL must not end with a stray period: ${u}`);
  assert.ok(urls[0].endsWith('abc123'), 'the original link must be recoverable without the trailing period');
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
