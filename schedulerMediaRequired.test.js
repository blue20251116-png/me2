'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { chooseImageFallback, assertHasMedia } = require('./scheduler');

// 2026-09-16 (user request, viral-formula screenshot: "사진과 영상은 꼭 넣으세요"): the Coupang
// autopilot path must never publish a text-only post - chooseImageFallback()'s own label calls
// the empty case '미디어 없음', and assertHasMedia() turns exactly that case into a
// CONTENT_QUALITY_HOLD (material preserved, retried later) instead of letting it reach
// saveAutopilotPost(). See scheduler.js's runAutopilotOnceInner for where this is wired in.

test('chooseImageFallback falls back to the Coupang product image when no source images exist', () => {
  const result = { sourceImages: [], product: { image: 'https://example.com/product.jpg' } };
  const media = chooseImageFallback(result);
  assert.equal(media.imageUrl, 'https://example.com/product.jpg');
  assert.equal(media.imageSourceLabel, 'Threads 미디어 없음 → 쿠팡 상품 이미지 1장');
});

test('chooseImageFallback reports 미디어 없음 when there is truly no image anywhere', () => {
  const result = { sourceImages: [], product: {} };
  const media = chooseImageFallback(result);
  assert.equal(media.imageUrl, null);
  assert.equal(media.videoUrl, null);
  assert.equal(media.imageSourceLabel, '미디어 없음');
});

test('assertHasMedia passes silently when an image or video is present', () => {
  assert.doesNotThrow(() => assertHasMedia({ imageUrl: 'https://example.com/a.jpg', videoUrl: null }));
  assert.doesNotThrow(() => assertHasMedia({ imageUrl: null, videoUrl: 'https://example.com/a.mp4' }));
});

test('assertHasMedia throws a CONTENT_QUALITY_HOLD when there is no media at all', () => {
  assert.throws(
    () => assertHasMedia({ imageUrl: null, videoUrl: null }, { accountId: 1, target: '전체', mode: 'product', topic: '테스트' }),
    (err) => err.code === 'CONTENT_QUALITY_HOLD' && err.isContentQualityHold === true
  );
});

test('assertHasMedia tolerates a missing context object (still throws the right error)', () => {
  assert.throws(() => assertHasMedia({}), (err) => err.code === 'CONTENT_QUALITY_HOLD');
});
