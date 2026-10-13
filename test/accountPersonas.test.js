'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real SQLite in a throwaway data dir - never the live db/scheduler.db.
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-personas-'));

const { db } = require('../src/infra/db');
const ap = require('../src/content/accountPersonas');
const { voiceProblems } = require('../src/content/voicePolicy');
const { PERSONAS } = require('../src/content/personas');
const slots = require('../src/publish/slots');
const mix = require('../src/autopilot/accountMix');
const aiCalls = require('../src/autopilot/aiCalls');

const OWNER_IDS = [1, 2, 3, 10, 11, 13, 14];
const CUSTOMER_IDS = [4, 6, 7, 15, 16, 20, 23, 24, 30, 35];

for (const id of [...OWNER_IDS, ...CUSTOMER_IDS])
  db.prepare('INSERT OR IGNORE INTO accounts (id,label) VALUES (?,?)').run(id, `acct${id}`);

function insertPost(accountId, { scheduledAt, link = null, status = 'pending', keys = null }) {
  db.prepare(`INSERT INTO posts (account_id,text,link,scheduled_at,status,dedupe_keys) VALUES (?,?,?,?,?,?)`).run(
    accountId,
    't',
    link,
    scheduledAt,
    status,
    keys
  );
}
function clearPosts() {
  db.prepare('DELETE FROM posts').run();
}

test('config: the 7 owner accounts each get their own distinct fixed persona', () => {
  const ids = OWNER_IDS.map(id => ap.accountPersonaFor(id)?.id);
  assert.ok(ids.every(Boolean), 'every owner account has a persona');
  assert.equal(new Set(ids).size, 7, 'no two owner accounts share a persona');
  assert.deepEqual(
    ap.personaAccountIds().sort((a, b) => a - b),
    OWNER_IDS
  );
});

test('config: customer accounts have no fixed persona and no banned phrases', () => {
  for (const id of CUSTOMER_IDS) {
    assert.equal(ap.accountPersonaFor(id), null);
    assert.equal(ap.isPersonaAccount(id), false);
    assert.deepEqual(ap.bannedPhrasesFor(id), []);
  }
});

test('personas: each block holds the full profile and its own examples never trip the shared checks', () => {
  for (const id of OWNER_IDS) {
    const p = ap.accountPersonaFor(id);
    for (const field of ['life', 'family', 'routine', 'home', 'interests', 'speech', 'never'])
      assert.ok(p.block.includes(p[field]), `${p.id} block has ${field}`);
    assert.ok(p.signaturePhrases.length >= 3 && p.dailyTopics.length >= 5);
    const banned = ap.bannedPhrasesFor(id);
    // Another account's signature phrase in this persona's own prompt would make the model write it.
    assert.deepEqual(ap.bannedPhraseHits(p.block.replace(ap.COMMON_ACCOUNT_RULES, ''), banned), [], p.id);
    for (const line of [...p.openers, ...p.closers]) {
      const problems = voiceProblems(line, { bannedPhrases: banned });
      assert.ok(!problems.includes('상투적 표현'), `${p.id}: "${line}" uses a banned cliché/self-ID hook`);
      assert.ok(!problems.includes('다른 계정 말투'), `${p.id}: "${line}"`);
    }
  }
});

test("signature check: a draft with another owner account's phrase or a stock line is rejected", () => {
  const draft = sig => `퇴근하고 저녁 차리다가\n${sig} 냉장고 앞에서 한참 서 있었음\n\n다들 저녁 몇 시에 먹어?`;
  const chichi = ap.accountPersonaFor(2).signaturePhrases[0];
  assert.ok(voiceProblems(draft(chichi), { bannedPhrases: ap.bannedPhrasesFor(1) }).includes('다른 계정 말투'));
  // The persona's own tic is fine on its own account.
  assert.ok(!voiceProblems(draft(chichi), { bannedPhrases: ap.bannedPhrasesFor(2) }).includes('다른 계정 말투'));
  assert.ok(
    voiceProblems(draft('호텔 셰프님이 알려줬는데'), { bannedPhrases: ap.bannedPhrasesFor(13) }).includes(
      '다른 계정 말투'
    )
  );
  // Customer accounts: no extra check at all.
  assert.ok(!voiceProblems(draft(chichi), { bannedPhrases: ap.bannedPhrasesFor(4) }).includes('다른 계정 말투'));
  assert.ok(!voiceProblems(draft(chichi)).includes('다른 계정 말투'));
});

test('postWriter: owner accounts always write as their fixed persona, customers keep the random pick', async () => {
  const systems = [];
  const original = aiCalls.callAiText;
  aiCalls.callAiText = async (_id, system) => {
    systems.push(system);
    return { text: '퇴근하고 냉장고 열었는데 반찬이 없음\n\n대충 볶아서 한 끼 해결함ㅋㅋ', commentLead: '' };
  };
  delete require.cache[require.resolve('../src/autopilot/postWriter')];
  const { generatePost } = require('../src/autopilot/postWriter');
  const args = {
    material: { sourceText: '샤워하고 바로 바르는 바디로션', authorReplies: '' },
    analysis: { mode: 'product', topic: '바디로션', vision: {} },
    product: { name: '바디로션' },
    target: '전체',
  };
  try {
    for (const id of OWNER_IDS) {
      for (let i = 0; i < 3; i++) {
        const out = await generatePost(id, args);
        assert.equal(out.persona, ap.accountPersonaFor(id).id);
        assert.ok(systems.at(-1).includes(ap.accountPersonaFor(id).summary));
      }
    }
    const randomIds = new Set(PERSONAS.map(p => p.id));
    for (const id of CUSTOMER_IDS) {
      const out = await generatePost(id, args);
      assert.ok(randomIds.has(out.persona), `customer #${id} still uses the shared persona pool`);
    }
  } finally {
    aiCalls.callAiText = original;
    delete require.cache[require.resolve('../src/autopilot/postWriter')];
  }
});

test('ad/non-ad mix: at least half link-free, linked posts capped per day', () => {
  for (const total of [4, 5, 8]) {
    let linked = 0,
      plain = 0;
    for (let i = 0; i < total; i++) {
      if (mix.decideSlotKind({ linked, plain, maxLinked: 2 }) === 'linked') linked++;
      else plain++;
    }
    assert.ok(linked <= 2, `total=${total} linked=${linked}`);
    assert.ok(plain >= linked, `total=${total} plain=${plain} linked=${linked}`);
    if (total >= 4) assert.equal(linked, 2);
  }
  assert.equal(mix.decideSlotKind({ linked: 0, plain: 0, maxLinked: 2 }), 'daily');
});

test("slotKind reads the slot's KST day from the DB and is null for customer accounts", () => {
  clearPosts();
  const at = '2026-10-14T03:00:00.000Z'; // 12:00 KST
  assert.equal(mix.slotKind(1, at), 'daily');
  insertPost(1, { scheduledAt: '2026-10-13T23:30:00.000Z' }); // 08:30 KST same day, link-free
  assert.equal(mix.slotKind(1, at), 'linked');
  insertPost(1, { scheduledAt: '2026-10-14T01:00:00.000Z', link: 'https://link.coupang.com/a' });
  assert.equal(mix.slotKind(1, at), 'daily');
  insertPost(1, { scheduledAt: '2026-10-14T04:00:00.000Z' });
  insertPost(1, { scheduledAt: '2026-10-14T06:00:00.000Z', link: 'https://link.coupang.com/b' });
  insertPost(1, { scheduledAt: '2026-10-14T08:00:00.000Z' });
  assert.equal(mix.slotKind(1, at), 'daily', 'cap of 2 linked posts reached');
  // A failed post does not count; another day starts fresh.
  assert.equal(mix.slotKind(1, '2026-10-15T03:00:00.000Z'), 'daily');
  assert.equal(mix.slotKind(4, at), null);
  clearPosts();
});

test('volume: owner accounts target 4-5 posts/day inside 08-23 KST; customers keep plan targets', () => {
  assert.equal(slots.targetForAccount({ id: 1, user_id: 1 }), 5);
  assert.equal(slots.targetForAccount({ id: 13, user_id: 7 }), 5);
  assert.equal(slots.targetForAccount({ id: 4 }), 25);
  assert.equal(slots.personaChainOptions(4), null);
  const opts = slots.personaChainOptions(1);
  assert.deepEqual(
    [opts.dailyMin, opts.dailyMax, opts.startHour, opts.endHour, opts.gapMin, opts.gapMax],
    [4, 5, 8, 23, 150, 210]
  );
  const step = slots.chainStepper(1, 5, 0, () => 0, opts);
  const out = [];
  for (let s = step(); s; s = step()) out.push(s.getTime());
  const perDay = new Map();
  for (let i = 0; i < out.length; i++) {
    const kstHour = new Date(out[i] + 9 * 3600000).getUTCHours();
    assert.ok(kstHour >= 8 && kstHour < 23, `slot at ${kstHour}h KST`);
    if (i) assert.ok(out[i] - out[i - 1] >= 150 * 60000, 'gap >= 150 minutes');
    const day = slots.dayKeyKst(new Date(out[i]));
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const counts = [...perDay.values()];
  assert.ok(counts.every(c => c <= 5));
  // Full future days (not today, which may already be partly over) hold 4-5 posts.
  assert.ok(
    counts.slice(1).every(c => c >= 4),
    JSON.stringify(counts)
  );
});

test('dedupe: same product within 7 days on one account, or same day across owner accounts, is a duplicate', () => {
  clearPosts();
  const keys = mix.dedupeKeysFor({
    product: { productId: 123, name: '금목서 바디로션 300ml' },
    sourceUrl: 'https://www.threads.com/@x/post/ABC?xmt=1',
    topic: '샤워 바디로션',
    searchTerm: 'source-author-affiliate-productId-ground-truth',
  });
  assert.ok(keys.includes('p:123') && keys.some(k => k.startsWith('s:')) && !keys.some(k => k.startsWith('q:')));
  insertPost(13, { scheduledAt: '2026-10-10T03:00:00.000Z', keys: mix.encodeKeys(keys) });
  const sameProduct = mix.dedupeKeysFor({ product: { productId: 123, name: '다른 이름' } });
  // Own account: 4 days later is a duplicate, 8 days later is not.
  assert.equal(mix.findDuplicate(13, sameProduct, '2026-10-14T03:00:00.000Z')?.scope, 'own');
  assert.equal(mix.findDuplicate(13, sameProduct, '2026-10-18T05:00:00.000Z'), null);
  // Another owner account: same KST day is a duplicate, the next day is not.
  assert.deepEqual(mix.findDuplicate(14, sameProduct, '2026-10-10T09:00:00.000Z'), {
    key: 'p:123',
    scope: 'cross',
    accountId: 13,
  });
  assert.equal(mix.findDuplicate(14, sameProduct, '2026-10-11T03:00:00.000Z'), null);
  // Same source post reused by another owner account the same day.
  const sameSource = mix.dedupeKeysFor({ sourceUrl: 'https://www.threads.com/@x/post/ABC' });
  assert.equal(mix.findDuplicate(1, sameSource, '2026-10-10T10:00:00.000Z')?.scope, 'cross');
  // Customer accounts are never checked.
  assert.equal(mix.findDuplicate(4, sameProduct, '2026-10-10T09:00:00.000Z'), null);
  assert.deepEqual(mix.generationFilters(4, '2026-10-10T09:00:00.000Z'), {});
  // The material filter skips a duplicate source before any AI work.
  const f = mix.generationFilters(1, '2026-10-10T10:00:00.000Z');
  assert.match(f.materialFilter({ url: 'https://www.threads.com/@x/post/ABC', sourceText: '바디로션' }), /중복 소재/);
  assert.equal(f.materialFilter({ url: 'https://www.threads.com/@y/post/ZZZ', sourceText: '바디로션' }), null);
  clearPosts();
});

test('daily post: owner accounts get a link-free post in their own voice, retried past a foreign phrase', async () => {
  const aiClient = require('../src/integrations/aiClient');
  const original = aiClient.callAI;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const calls = [];
  const replies = [
    '오늘의 홈카페 하다가 커피를 쏟음\n\n다들 아침 첫 잔 뭐 마셔?', // persona 14's phrase on account 2 → rejected
    '퇴근하고 둘 다 녹초라 소파에 그대로 누움ㅋㅋㅋ\n\n다들 평일 저녁 몇 분 안에 끝내?',
  ];
  aiClient.callAI = async (_key, req) => {
    calls.push(req);
    return replies[calls.length - 1];
  };
  delete require.cache[require.resolve('../src/content/contentOnlyAutomation')];
  try {
    const { generateDailyStory } = require('../src/content/contentOnlyAutomation');
    const r = await generateDailyStory(2, '전체');
    assert.equal(r.persona, ap.accountPersonaFor(2).id);
    assert.equal(r.link, null);
    assert.equal(r.imageUrl, null);
    assert.equal(calls.length, 2, "first draft rejected for another account's signature phrase");
    assert.ok(calls[0].system.includes(ap.accountPersonaFor(2).summary));
    assert.ok(calls[0].system.includes('링크·상품 없는 글'));
    assert.match(calls[1].userContent, /다른 계정 말투/);
    assert.match(r.text, /소파에 그대로 누움/);
  } finally {
    aiClient.callAI = original;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    delete require.cache[require.resolve('../src/content/contentOnlyAutomation')];
  }
});
