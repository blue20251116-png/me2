'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePublishedThreadsText, prepareReplyLinks } = require('../src/threads/publishText');

test('sanitizePublishedThreadsText strips a lone trailing sentence period', () => {
  assert.equal(sanitizePublishedThreadsText('이거 실화냐.'), '이거 실화냐');
  assert.equal(sanitizePublishedThreadsText('문장하나. 문장둘.'), '문장하나 문장둘');
});

test('sanitizePublishedThreadsText preserves decimal points', () => {
  assert.equal(sanitizePublishedThreadsText('가격 1.5만원인데'), '가격 1.5만원인데');
});

test('sanitizePublishedThreadsText strips a stray "ㅡ"/"—"/"–" used as a standalone dash separator', () => {
  // REGRESSION (found live, 2026-09-15): a real published post included a bare "ㅡ" used as a
  // dash/separator ("이거 완전 신기함 ㅡ 진짜 대박임") - voiceGuide() only ever sanctions
  // "ㅋㅋ, ㄷㄷ, ㅠㅠ, ;;" as casual reaction markers, never a bare dash. The likely source is
  // voiceGuide()'s own prompt text, which is full of em dashes ("—") as a meta-formatting device
  // the model can imitate back into its actual output - surfacing as "—"/"–"/the Hangul "ㅡ" (the
  // same keystroke Korean users reach for as a quick dash substitute).
  assert.equal(sanitizePublishedThreadsText('이거 완전 신기함 ㅡ 진짜 대박임'), '이거 완전 신기함 진짜 대박임');
  assert.equal(sanitizePublishedThreadsText('이거 — 진짜 대박'), '이거 진짜 대박');
  assert.equal(sanitizePublishedThreadsText('이거 – 진짜 대박'), '이거 진짜 대박');
  assert.equal(sanitizePublishedThreadsText('완전 신기함\nㅡ\n진짜 대박임'), '완전 신기함\n\n진짜 대박임');
  assert.equal(sanitizePublishedThreadsText('ㅡ 시작부터 이러네'), '시작부터 이러네');
  assert.equal(sanitizePublishedThreadsText('이러다 끝나네 ㅡ'), '이러다 끝나네');
  // A dash directly attached to a word with no surrounding space is the genuine "-_-"
  // unimpressed-face emoticon shape (same attach pattern as ㅋㅋ/ㄷㄷ) and must stay untouched.
  assert.equal(sanitizePublishedThreadsText('이거ㅡㅡ완전웃김'), '이거ㅡㅡ완전웃김');
  assert.equal(sanitizePublishedThreadsText('음ㅡㅡ 그건 좀'), '음ㅡㅡ 그건 좀');
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

test('sanitizePublishedThreadsText strips a sentence period stuck directly to a trailing emoji or reaction, no space', () => {
  // REGRESSION (found via synthetic testing, hourly review, 2026-09-13): the strip required
  // whitespace or end-of-string right after the period, but real casual posts very often tack a
  // reaction straight onto it with no space at all ("실화냐.ㅋㅋ", "대박.😂") - exactly the formal
  // sentence-final period this function exists to remove, left untouched purely because of what
  // followed it.
  // 2026-09-23: the no-emoji policy (see stripEmoji below) now also removes the pictograph
  // reaction itself, not just the period before it - only the text-only reactions (ㅋㅋ/ㅎㅎ) survive.
  assert.equal(sanitizePublishedThreadsText('이거 완전 대박.😂'), '이거 완전 대박');
  assert.equal(sanitizePublishedThreadsText('진짜 신기함.🤯'), '진짜 신기함');
  assert.equal(sanitizePublishedThreadsText('이 조합 실화냐.ㅋㅋ'), '이 조합 실화냐ㅋㅋ');
  assert.equal(sanitizePublishedThreadsText('가성비 최고.👍'), '가성비 최고');
  assert.equal(sanitizePublishedThreadsText('완전 웃김.ㅎㅎ'), '완전 웃김ㅎㅎ');
  assert.equal(sanitizePublishedThreadsText('이거 실화냐.!'), '이거 실화냐!');
});

test('the emoji/reaction lookahead extension still preserves decimal points and ellipses right before a reaction', () => {
  assert.equal(sanitizePublishedThreadsText('가격 1.5만원인데.ㅋㅋ'), '가격 1.5만원인데ㅋㅋ');
  assert.equal(sanitizePublishedThreadsText('완전 신기함...😂'), '완전 신기함...');
});

test('sanitizePublishedThreadsText strips pictograph emoji anywhere, keeping text-only reactions', () => {
  // REGRESSION (found live, 2026-09-23): a real published post still included an emoji
  // ("쿠션감이 장난 아님...\n😭 구름 위를...") despite voiceGuide() explicitly banning emoji
  // everywhere (2026-09-21) - that ban was only a prompt instruction with no code-side
  // enforcement, so a model that ignored it published unchanged. This is the same gap class the
  // "ㅡ" dash fix already closed for a different unwanted character.
  assert.equal(
    sanitizePublishedThreadsText('쿠션감이 장난 아님\n😭 구름 위를 걷는 기분이랄까'),
    '쿠션감이 장난 아님\n구름 위를 걷는 기분이랄까'
  );
  assert.equal(sanitizePublishedThreadsText('이거 완전 좋음🥰 진짜 만족'), '이거 완전 좋음 진짜 만족');
  assert.equal(sanitizePublishedThreadsText('오늘 날씨 맑음🌤️✨'), '오늘 날씨 맑음');
  // Text-only reactions (ㅋㅋ/ㄷㄷ/ㅠㅠ/;;) are not pictograph emoji and must survive untouched.
  assert.equal(sanitizePublishedThreadsText('이거 완전 웃김ㅋㅋㅋ'), '이거 완전 웃김ㅋㅋㅋ');
});

test("sanitizePublishedThreadsText also strips the period before ㄷㄷ/;; - voiceGuide()'s own other two sanctioned reaction markers", () => {
  // REGRESSION (found via synthetic testing, hourly review, 2026-09-13): voiceGuide() explicitly
  // names "ㅋㅋ, ㄷㄷ, ㅠㅠ, ;;" as the sanctioned casual reaction markers, but the lookahead above
  // only ever covered ㅋㅎㅜㅠ~!? - "ㄷ" (ㄷㄷ) and ";" (;;) were both missing, so "실화냐.ㄷㄷ" and
  // "대박.;;" kept the exact formal-period artifact this function exists to strip, while the
  // otherwise-identical "실화냐.ㅋㅋ" was already handled correctly.
  assert.equal(sanitizePublishedThreadsText('이거 실화냐.ㄷㄷ'), '이거 실화냐ㄷㄷ');
  assert.equal(sanitizePublishedThreadsText('가격 실화냐.ㄷㄷㄷ'), '가격 실화냐ㄷㄷㄷ');
  assert.equal(sanitizePublishedThreadsText('이거 대박.;;'), '이거 대박;;');
  assert.equal(sanitizePublishedThreadsText('가격 1.5만원인데.ㄷㄷ'), '가격 1.5만원인데ㄷㄷ');
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

test('reply links lose their scheme (no preview card) and keep a clean ending', () => {
  const result = prepareReplyLinks('이 상품 진짜 좋아요 https://link.coupang.com/a/abc123.', 'bare');
  assert.equal(result.text, '이 상품 진짜 좋아요 link.coupang.com/a/abc123');
  assert.equal(result.linkCount, 1);
});

test('reply links: any domain, repeated URLs dropped, text without links untouched', () => {
  const plain = 'https://www.coupang.com/vp/products/12345?itemId=1&vendorItemId=2';
  assert.equal(prepareReplyLinks(`좋아요\n${plain}`, 'bare').text, `좋아요\n${plain.slice('https://'.length)}`);

  const repeated = prepareReplyLinks('a https://link.coupang.com/a/x\nhttps://link.coupang.com/a/x', 'bare');
  assert.equal(repeated.text, 'a link.coupang.com/a/x');
  assert.equal(repeated.linkCount, 1);

  assert.deepEqual(prepareReplyLinks('그냥 텍스트 댓글', 'bare'), {
    text: '그냥 텍스트 댓글',
    linkCount: 0,
    style: 'bare',
  });
});

test('THREADS_REPLY_LINK_STYLE=full keeps the scheme as an instant rollback', () => {
  const previous = process.env.THREADS_REPLY_LINK_STYLE;
  process.env.THREADS_REPLY_LINK_STYLE = 'full';
  try {
    assert.equal(prepareReplyLinks('링크 https://link.coupang.com/a/x').text, '링크 https://link.coupang.com/a/x');
  } finally {
    if (previous === undefined) delete process.env.THREADS_REPLY_LINK_STYLE;
    else process.env.THREADS_REPLY_LINK_STYLE = previous;
  }
  assert.equal(prepareReplyLinks('링크 https://link.coupang.com/a/x').text, '링크 link.coupang.com/a/x');
});
