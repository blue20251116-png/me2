'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./coupangSoldFirstPatch'), 'utf8');

test('Coupang matching separates sold identity from search context', () => {
  assert.match(source, /SOLD_FIRST_CONTEXT_WORDS/);
  assert.match(source, /function soldFirstIdentityWords/);
  assert.match(source, /findProduct\(accountId,terms,identityTerm\)/);
  assert.match(source, /soldFirstCandidateMatch\(term,x\?\.name,identityTerm\)/);
  assert.match(source, /const soldIdentity=clean\(vision\?\.soldObject\|\|analysis\?\.topic\|\|''\)/);
});

test('generic discovery words do not become required identity tokens', () => {
  for (const word of ['추천','인기','가성비','주방','요리','생활용품','청소','식단']) {
    assert.match(source, new RegExp(`['\"]${word}['\"]`));
  }
  assert.match(source, /!SOLD_FIRST_CONTEXT_WORDS\.has\(x\)/);
});

test('country identity remains fail-closed', () => {
  assert.match(source, /const countryOk=countries\.every/);
  assert.match(source, /identity-country-mismatch/);
  assert.match(source, /continue;/);
  assert.match(source, /불일치 fail-closed/);
});
