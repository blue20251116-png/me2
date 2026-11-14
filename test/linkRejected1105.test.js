'use strict';
// dev 936a5d23 (2026-11-05): a product whose Coupang deeplink is refused is dropped, not posted with a plain URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('accountMix remembers refused products for 7 days and the filter skips them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'accountMix.js'), 'utf8');
  const start = src.indexOf('const LINK_REJECT_TTL_MS');
  const end = src.indexOf('function generationFilters');
  const mod = {};
  new Function('mod', src.slice(start, end) + '\nmod.mark = markLinkRejected; mod.is = isLinkRejected; mod.filter = linkRejectFilter;')(mod);
  const p = { productId: 63107855, url: 'https://www.coupang.com/vp/products/63107855?itemId=1' };
  assert.equal(mod.filter({ product: p }), null);
  const t0 = Date.now(); mod.mark(p, t0);
  assert.equal(mod.is(p, t0 + 1000), true);
  assert.match(mod.filter({ product: { url: 'https://www.coupang.com/vp/products/63107855?x=2' } }), /딥링크 변환 거부/);
  assert.equal(mod.is(p, t0 + 8 * 86400000), false);
});

test('runner no longer returns the plain URL when conversion is refused', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'runner.js'), 'utf8');
  const body = src.slice(src.indexOf('async function makeAffiliateLink'), src.indexOf('// ---------- 미래 예약 슬롯'));
  assert.match(body, /COUPANG_LINK_REJECTED/);
  assert.match(body, /markLinkRejected/);
  assert.doesNotMatch(body, /url convert failed[^]*?return raw;/);
  assert.match(src, /productFilter: accountMix\.linkRejectFilter/);
});
