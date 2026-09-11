'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(require.resolve('./autopilotMaterialEngine'), 'utf8');

// findProduct() isn't part of the module's public exports (only
// buildThreadsFirstAutopilot is), so extract it into a throwaway copy of the
// file (written alongside the original so its own relative require()s still
// resolve) for a real behavioral test instead of only checking source text.
function loadFindProduct() {
  const tmpFile = path.join(__dirname, `__engine_findproduct_test_${process.pid}.js`);
  fs.writeFileSync(tmpFile, source + '\nmodule.exports.findProduct = findProduct;\n');
  try {
    return require(tmpFile).findProduct;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

test('Coupang matching separates sold identity from search context', () => {
  assert.match(source, /SOLD_FIRST_CONTEXT_WORDS/);
  assert.match(source, /function soldFirstIdentityWords/);
  assert.match(source, /findProduct\(accountId,terms,identityTerm\)/);
  assert.match(source, /soldFirstCandidateMatch\(term,x\?\.name,identityTerm\)/);
  assert.match(source, /const soldIdentity=clean\(vision\?\.soldObject\|\|analysis\?\.topic\|\|''\)/);
});

test('generic discovery words do not become required identity tokens', () => {
  for (const word of ['추천','인기','가성비','주방','요리','생활용품','청소','식단']) {
    assert.match(source, new RegExp(`['"]${word}['"]`));
  }
  assert.match(source, /!SOLD_FIRST_CONTEXT_WORDS\.has\(x\)/);
});

test('country identity remains fail-closed', () => {
  assert.match(source, /const countryOk=countries\.every/);
  assert.match(source, /identity-country-mismatch/);
  assert.match(source, /continue;/);
  assert.match(source, /\[AutopilotV3\]\[COUPANG MATCH REJECT\]/);
});

test('findProduct falls back to the top search result when no candidate confidently matches the identity', async () => {
  // Regression: activating this stricter matching removed the previous
  // fallback (return exact||p[0] when there were no specific identity
  // constraints to check), so any search where none of the up to 8 results
  // literally contained every identity token failed the whole material
  // outright ({product:null}) instead of publishing with Coupang's own top
  // result, like the system always did before. This measurably reduced
  // successful autopilot publishes ("발행 잘안되" - user report).
  const findProduct = loadFindProduct();
  const coupangApi = require('./coupangApi');
  const originalSearchProducts = coupangApi.searchProducts;
  coupangApi.searchProducts = async () => [
    { productId: 1, name: '한율 자운고 진정 크림 70ml 여드름 피부 진정 보습', url: 'https://coupang.com/p/1' },
    { productId: 2, name: '이니스프리 그린티 밸런스 스킨 200ml', url: 'https://coupang.com/p/2' },
  ];
  try {
    const result = await findProduct(1, ['수분크림'], '수분크림');
    assert.ok(result.product, 'findProduct must not give up when nothing matches confidently');
    assert.equal(result.product.productId, 1, 'fallback should be the first search result');
  } finally {
    coupangApi.searchProducts = originalSearchProducts;
  }
});

test('findProduct still prefers a confidently-matched candidate over the fallback', async () => {
  const findProduct = loadFindProduct();
  const coupangApi = require('./coupangApi');
  const originalSearchProducts = coupangApi.searchProducts;
  coupangApi.searchProducts = async () => [
    { productId: 1, name: '일본 하다라보 고쿠준 수분크림 170ml', url: 'https://coupang.com/p/1' },
    { productId: 2, name: '국산 순한 수분크림 저자극', url: 'https://coupang.com/p/2' },
  ];
  try {
    const result = await findProduct(1, ['일본 수분크림'], '일본 수분크림');
    assert.equal(result.product.productId, 1, 'the country-matching candidate should win, not just the first result');
  } finally {
    coupangApi.searchProducts = originalSearchProducts;
  }
});
