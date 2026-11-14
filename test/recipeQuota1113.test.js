'use strict';
// 2026-11-13 (AI company dev aad7afc8): account 10 gets its recipe posts every day
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-recipe-'));
process.env.ME2_SECRET_KEY = 'recipe-quota-test-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recipeQuotaFor, recipeFirst } = require('../src/autopilot/recipeQuota');

const config = { minRecipePerDayByAccount: { 10: 3 }, recipeKeywordsByAccount: { 10: ['에어프라이어', '통째로'] }, recipeEveningHours: [20, 22] };

test('the day short of recipes: deficit, evening slots strict, other accounts untouched', () => {
  const morning = '2026-11-13T00:30:00.000Z'; // 09:30 KST
  const evening = '2026-11-13T11:10:00.000Z'; // 20:10 KST
  const q1 = recipeQuotaFor(10, morning, { config, count: () => 1 });
  assert.deepEqual([q1.min, q1.count, q1.deficit, q1.strict], [3, 1, 2, false]);
  assert.deepEqual(q1.keywords, ['에어프라이어', '통째로']);
  assert.equal(recipeQuotaFor(10, evening, { config, count: () => 1 }).strict, true);
  assert.equal(recipeQuotaFor(10, morning, { config, count: () => 1, slotsLeft: 2 }).strict, true, 'deficit as big as the slots left');
  assert.equal(recipeQuotaFor(10, evening, { config, count: () => 3 }).deficit, 0);
  assert.equal(recipeQuotaFor(3, evening, { config, count: () => 0 }), null);
});

test('recipe-looking materials go first, order kept otherwise', () => {
  const ms = [{ text: '수납 꿀템' }, { text: '에어프라이어 통삼겹' }, { text: '청소' }, { text: '오늘 저녁 레시피', r: 1 }];
  const out = recipeFirst(ms, ['에어프라이어'], (m) => (m.r ? 'recipe' : null));
  assert.deepEqual(out.map((m) => m.text), ['에어프라이어 통삼겹', '오늘 저녁 레시피', '수납 꿀템', '청소']);
});

test('counts the day in the DB (content_mode recipe, live statuses only)', () => {
  const { db, createAccount, createUser } = require('../src/infra/db');
  const { recipeCountOnDay } = require('../src/autopilot/recipeQuota');
  createUser('recipe@test.local', 'x:y', 'r||THREADS:recipe_t');
  const userId = db.prepare("SELECT id FROM users WHERE email='recipe@test.local'").get().id;
  const acc = Number(createAccount('market', userId));
  const ins = db.prepare(`INSERT INTO posts (text, scheduled_at, account_id, status, content_mode) VALUES ('t', ?, ${acc}, ?, ?)`);
  ins.run('2026-11-13T02:00:00.000Z', 'posted', 'recipe');
  ins.run('2026-11-13T05:00:00.000Z', 'pending', 'recipe');
  ins.run('2026-11-13T06:00:00.000Z', 'failed', 'recipe');
  ins.run('2026-11-13T07:00:00.000Z', 'posted', 'product');
  ins.run('2026-11-12T10:00:00.000Z', 'posted', 'recipe'); // 11/12 19:00 KST
  assert.equal(recipeCountOnDay(acc, '2026-11-13'), 2);
});
