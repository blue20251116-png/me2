'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://example.test';

const { cacheFilePrefix, findCachedFile, cacheImage, uploadsDir } = require('./imageCachePatch');
const axios = require('axios');

// REGRESSION (found via review, tied to a real disk-full production incident): cacheImage() used
// to name every cached file `threads-img-${Date.now()}-${random}${ext}`, so it was never
// idempotent for the same source URL. posts.image_url in the DB always stays the ORIGINAL
// external Threads/Instagram URL (nothing ever writes the cached local URL back to it), so every
// retry of a post whose publish failed for an unrelated reason re-downloaded and re-wrote a brand
// new duplicate copy of the same image to the persistent volume - unbounded disk growth on
// retries. The fix derives the filename deterministically from the source URL so a repeat call
// reuses the existing file instead of downloading and writing a new one.

test('cacheFilePrefix is deterministic for the same URL and different for different URLs', () => {
  const a1 = cacheFilePrefix('https://cdn.example.com/photo1.jpg');
  const a2 = cacheFilePrefix('https://cdn.example.com/photo1.jpg');
  const b = cacheFilePrefix('https://cdn.example.com/photo2.jpg');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.ok(a1.startsWith('threads-img-'));
});

test('findCachedFile locates a previously-cached file by its deterministic prefix', () => {
  const url = 'https://cdn.example.com/regression-test-photo.jpg';
  const prefix = cacheFilePrefix(url);
  const filename = `${prefix}.jpg`;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, Buffer.from('fake-image-bytes'));
  try {
    assert.equal(findCachedFile(prefix), filename);
  } finally {
    fs.unlinkSync(filepath);
  }
});

test('cacheImage reuses an existing cached file for the same URL without hitting the network again', async () => {
  const url = 'https://cdn.example.com/regression-test-second-call.jpg';
  const prefix = cacheFilePrefix(url);
  const filename = `${prefix}.jpg`;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, Buffer.from('already-cached'));

  const originalGet = axios.get;
  let networkCalled = false;
  axios.get = async () => { networkCalled = true; throw new Error('network should not be called on a cache hit'); };
  try {
    const result = await cacheImage(url);
    assert.equal(networkCalled, false, 'a cache hit must not trigger a network request');
    assert.ok(result.includes(filename), `result should reference the cached file: ${result}`);
  } finally {
    axios.get = originalGet;
    fs.unlinkSync(filepath);
  }
});
