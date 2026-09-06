'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./sourceAffiliateOriginalLinkPriorityPatch'), 'utf8');

test('source affiliate resolver inspects redirect Location before full-page fallback', () => {
  assert.match(source, /maxRedirects:\s*0/);
  assert.match(source, /responseLocation\(first\)/);
  assert.match(source, /method:'redirect-location'/);
  assert.match(source, /method:'redirect-error-location'/);
});

test('source affiliate resolver still fails closed for unresolved or ambiguous identity', () => {
  assert.match(source, /SOURCE_AFFILIATE_PRODUCT_ID_UNRESOLVED/);
  assert.match(source, /SOURCE_AFFILIATE_MULTIPLE_PRODUCTS/);
  assert.match(source, /if \(!unique\.length\)/);
  assert.match(source, /if \(unique\.length > 1\)/);
});

test('ground-truth product preserves canonical identity fields', () => {
  assert.match(source, /productId:\s*picked\.productId/);
  assert.match(source, /itemId:\s*picked\.itemId/);
  assert.match(source, /vendorItemId:\s*picked\.vendorItemId/);
  assert.match(source, /sourceAffiliateProductIdGroundTruth:\s*true/);
});
