'use strict';
// 2026-11-11 (dev 869a6010, threads 2a81f547): per-account daily posts, video cap and slot times in accountPersonas.json;
// an account not listed keeps the shared values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-caps-'));
const ap = require('../src/content/accountPersonas');

test('per-account caps override the shared ones; others keep the shared values', () => {
  const ids = ap.ACCOUNT_PERSONAS.slice(0, 3).map((p) => p.id);
  ap.setAccountPersonaConfig({
    accounts: { 3: ids[0], 10: ids[1], 2: ids[2] }, dailyPostsMax: 10, maxVideoPerDay: 8,
    slotTemplate: ['08:00', '12:30', '17:30'],
    dailyPostsByAccount: { 3: 5, 10: 15 }, maxVideoPerDayByAccount: { 3: 5, 10: 11 },
    slotTemplateByAccount: { 3: ['08:00', '12:30', '17:30', '20:00', '22:00'] },
  });
  const a3 = ap.personaCapsFor(3); const a10 = ap.personaCapsFor(10); const a2 = ap.personaCapsFor(2);
  assert.equal(a3.dailyPostsMax, 5); assert.equal(a3.maxVideoPerDay, 5); assert.equal(a3.slotTemplateMinutes.length, 5);
  assert.equal(a10.dailyPostsMax, 15); assert.equal(a10.maxVideoPerDay, 11); assert.equal(a10.slotTemplateMinutes.length, 3, 'no own times: shared template');
  assert.equal(a2.dailyPostsMax, 10); assert.equal(a2.maxVideoPerDay, 8);
  assert.equal(a3.maxVideoPerDay + a10.maxVideoPerDay, 16, 'owner 11/03: video total kept at 16');
  const { personaChainOptions } = require('../src/publish/slots');
  assert.equal(personaChainOptions(3).dailyMax, 5);
  assert.equal(personaChainOptions(3).template.length, 5);
  assert.equal(personaChainOptions(2).template.length, 3);
  ap.setAccountPersonaConfig(null);
});
