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

test('postWriter: owner accounts support both fixed persona mode and view-weighted rotating persona mode', async () => {
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
  const baseCfg = ap.accountPersonaSettings();
  try {
    ap.setAccountPersonaConfig({ ...baseCfg, rotatePersonas: false });
    for (const id of OWNER_IDS) {
      for (let i = 0; i < 3; i++) {
        const out = await generatePost(id, args);
        assert.equal(out.persona, ap.accountPersonaFor(id).id);
        assert.ok(systems.at(-1).includes(ap.accountPersonaFor(id).summary));
      }
    }
    ap.setAccountPersonaConfig({ ...baseCfg, rotatePersonas: true });
    const sharedIds = new Set(PERSONAS.map(p => p.id));
    for (const id of OWNER_IDS) {
      const first = await generatePost(id, { ...args, lastPersona: 'reaction' });
      assert.notEqual(first.persona, 'reaction', 'never repeats lastPersona consecutively');
      const second = await generatePost(id, { ...args, lastPersona: first.persona });
      assert.notEqual(second.persona, first.persona, 'rotates to a different persona on the next post');
    }
    for (const id of CUSTOMER_IDS) {
      const out = await generatePost(id, args);
      assert.ok(sharedIds.has(out.persona), `customer #${id} still uses the shared persona pool`);
    }
  } finally {
    ap.setAccountPersonaConfig(baseCfg);
    aiCalls.callAiText = original;
    delete require.cache[require.resolve('../src/autopilot/postWriter')];
  }
});

test('day mix: 16 posts = 5 linked spread through the day, 1 everyday post (4th), 10 link-free material posts', () => {
  let linked = 0,
    plain = 0,
    daily = 0,
    seq = '';
  for (let i = 0; i < 16; i++) {
    const k = mix.decideSlotKind({ linked, plain, daily, maxLinked: 5, maxDaily: 1, dailyCap: 16 });
    seq += k === 'linked' ? 'L' : k === 'daily' ? 'D' : 'U';
    if (k === 'linked') linked++;
    else if (k === 'daily') daily++;
    else plain++;
  }
  assert.equal(seq, 'LUUDLUULUULUULUU');
  assert.deepEqual([linked, daily, plain], [5, 1, 10]);
  // No two linked posts in a row, and the cap holds even on a longer day.
  assert.ok(!/LL/.test(seq));
  assert.equal(
    mix.decideSlotKind({ linked: 5, plain: 20, daily: 1, maxLinked: 5, maxDaily: 1, dailyCap: 16 }),
    'unlinked'
  );
  // A day whose everyday post could not be made (no photo) keeps offering it only once per slot.
  assert.equal(mix.decideSlotKind({ linked: 1, plain: 2, daily: 0, maxLinked: 5, maxDaily: 1, dailyCap: 16 }), 'daily');
  assert.equal(
    mix.decideSlotKind({ linked: 1, plain: 2, daily: 0, maxLinked: 5, maxDaily: 0, dailyCap: 16 }),
    'unlinked'
  );
});

// These tests pin the original 4-5/day, 2-linked numbers; the live config file may use other values.
const LIVE_ACCOUNTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/config/accountPersonas.json'), 'utf8')
).accounts;
function pinBaseConfig() {
  ap.setAccountPersonaConfig({
    accounts: LIVE_ACCOUNTS,
    dailyPostsMin: 4,
    dailyPostsMax: 5,
    maxLinkedPerDay: 2,
    gapMinutesMin: 150,
    gapMinutesMax: 210,
    activeStartHour: 8,
    activeEndHour: 23,
    dedupeOwnDays: 7,
  });
}

test("slotKind reads the slot's KST day from the DB and is null for customer accounts", () => {
  ap.setAccountPersonaConfig({
    accounts: LIVE_ACCOUNTS,
    dailyPostsMin: 16,
    dailyPostsMax: 16,
    maxLinkedPerDay: 5,
    maxDailyPerDay: 1,
    gapMinutesMin: 50,
    gapMinutesMax: 60,
    activeStartHour: 8,
    activeEndHour: 23,
    dedupeOwnDays: 7,
  });
  clearPosts();
  const at = '2026-10-14T03:00:00.000Z'; // 12:00 KST
  assert.equal(mix.slotKind(1, at), 'linked');
  insertPost(1, { scheduledAt: '2026-10-13T23:30:00.000Z', link: 'https://link.coupang.com/a' }); // 08:30 KST
  assert.equal(mix.slotKind(1, at), 'unlinked');
  insertPost(1, { scheduledAt: '2026-10-14T00:30:00.000Z' });
  insertPost(1, { scheduledAt: '2026-10-14T01:30:00.000Z' });
  assert.equal(mix.slotKind(1, at), 'daily');
  db.prepare(
    `INSERT INTO posts (account_id,text,scheduled_at,status,content_mode) VALUES (1,'d','2026-10-14T02:30:00.000Z','posted','daily')`
  ).run();
  assert.equal(mix.dayMix(1, '2026-10-14').daily, 1);
  assert.equal(mix.slotKind(1, at), 'linked', 'everyday post used up, linked share due');
  // Another day starts fresh; customer accounts are never mixed.
  assert.equal(mix.slotKind(1, '2026-10-15T03:00:00.000Z'), 'linked');
  assert.equal(mix.slotKind(4, at), null);
  clearPosts();
});

test('maxDailyPerDayByAccount caps text-only posts for listed accounts only', () => {
  ap.setAccountPersonaConfig({
    accounts: LIVE_ACCOUNTS,
    dailyPostsMin: 10,
    dailyPostsMax: 10,
    maxLinkedPerDay: 5,
    maxDailyPerDay: 3,
    maxDailyPerDayByAccount: { 3: 1 },
  });
  assert.equal(ap.accountPersonaSettings().maxDailyPerDayByAccount[3], 1);
  clearPosts();
  const at = '2026-10-14T09:00:00.000Z';
  for (const id of [1, 3]) {
    insertPost(id, { scheduledAt: '2026-10-13T23:00:00.000Z', link: 'https://link.coupang.com/a' });
    insertPost(id, { scheduledAt: '2026-10-13T23:50:00.000Z' });
    insertPost(id, { scheduledAt: '2026-10-14T00:40:00.000Z', link: 'https://link.coupang.com/b' });
    db.prepare(
      `INSERT INTO posts (account_id,text,scheduled_at,status,content_mode) VALUES (?,'d','2026-10-14T01:30:00.000Z','posted','daily')`
    ).run(id);
    insertPost(id, { scheduledAt: '2026-10-14T03:30:00.000Z' });
    insertPost(id, { scheduledAt: '2026-10-14T06:00:00.000Z', link: 'https://link.coupang.com/c' });
  }
  // 6 posts, 1 daily: account 1 (cap 3) is due its 2nd daily, account 3 (cap 1) is not.
  assert.equal(mix.slotKind(1, at), 'daily');
  assert.notEqual(mix.slotKind(3, at), 'daily');
  clearPosts();
});

test('volume: owner accounts target 4-5 posts/day inside 08-23 KST; customers keep plan targets', () => {
  pinBaseConfig();
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

test('dedupe: same product/source/media within 7 days on any owner account, same topic the same day, is a duplicate', () => {
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
  // The same product on another owner account is blocked for 7 days; a loose topic key only on the same day.
  assert.equal(mix.findDuplicate(14, sameProduct, '2026-10-11T03:00:00.000Z')?.scope, 'cross');
  assert.equal(mix.findDuplicate(14, sameProduct, '2026-10-18T03:00:00.000Z'), null);
  const sameTopic = mix.dedupeKeysFor({ topic: '샤워 바디로션' });
  assert.equal(mix.findDuplicate(14, sameTopic, '2026-10-10T09:00:00.000Z')?.scope, 'cross');
  assert.equal(mix.findDuplicate(14, sameTopic, '2026-10-11T03:00:00.000Z'), null);
  // Same media file (m: key) on another owner account within 7 days.
  insertPost(2, {
    scheduledAt: '2026-10-12T03:00:00.000Z',
    keys: mix.encodeKeys(mix.dedupeKeysFor({ mediaHash: 'abc123def456' })),
  });
  assert.equal(
    mix.findDuplicate(11, mix.dedupeKeysFor({ mediaHash: 'abc123def456' }), '2026-10-15T03:00:00.000Z')?.key,
    'm:abc123def456'
  );
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

test('video cap: owner accounts get at most maxVideoPerDay re-uploaded-video posts per KST day', () => {
  ap.setAccountPersonaConfig({ accounts: LIVE_ACCOUNTS, dailyPostsMin: 16, dailyPostsMax: 16, maxLinkedPerDay: 5 });
  assert.equal(ap.accountPersonaSettings().maxVideoPerDay, 5, 'defaults to a third of the daily cap');
  ap.setAccountPersonaConfig({ accounts: LIVE_ACCOUNTS, dailyPostsMax: 16, maxVideoPerDay: 2 });
  clearPosts();
  const at = '2026-10-14T05:00:00.000Z';
  assert.equal(mix.videoAllowed(1, at), true);
  db.prepare(
    `INSERT INTO posts (account_id,text,scheduled_at,status,video_url) VALUES (1,'v','2026-10-14T01:00:00.000Z','posted','https://x/a.mp4')`
  ).run();
  db.prepare(
    `INSERT INTO posts (account_id,text,scheduled_at,status,image_url) VALUES (1,'v','2026-10-14T02:00:00.000Z','pending','__THREADS_MEDIA_BUNDLE__%5B%7B%22type%22%3A%22VIDEO%22%7D%5D')`
  ).run();
  db.prepare(
    `INSERT INTO posts (account_id,text,scheduled_at,status,image_url) VALUES (1,'i','2026-10-14T03:00:00.000Z','pending','https://x/a.jpg')`
  ).run();
  assert.equal(mix.videoPostsOnDay(1, at), 2);
  assert.equal(mix.videoAllowed(1, at), false);
  assert.equal(mix.videoAllowed(1, '2026-10-15T05:00:00.000Z'), true, 'next day starts fresh');
  assert.equal(mix.videoAllowed(4, at), true, 'customers unaffected');
  clearPosts();
});

test('near-duplicate text: a repeat on any owner account within 7 days is caught, unrelated posts are not', () => {
  pinBaseConfig();
  clearPosts();
  const lipA =
    '립 바르면 각질만 풀메이크업됨ㅋㅋ\n\n등원시키고 와서 거울 봤는데\n립밤이 각질에 다 끼어 있음\n바를수록 더 티 나는 느낌\n\n자기 전에 올려두고 잤더니 아침에 각질이 밀림';
  const lipB =
    '등원시키고 와서 거울 봤더니 립밤이 각질에 다 끼어 있음\n\n자기 전에 올려두고 잤더니 아침에 불어난 각질이 살살 문지르면 밀림';
  const other = '치치가 내 퇴근 시간만 되면 현관에 먼저 나와 있음ㅋㅋㅋ\n\n오늘은 택배 상자 안에서 눈만 빼꼼 내밀더라';
  db.prepare(`INSERT INTO posts (account_id,text,scheduled_at,status) VALUES (1,?,?,'posted')`).run(
    lipA,
    '2026-10-14T02:39:00.000Z'
  );
  assert.ok(mix.textSimilarity(lipA, lipB) >= mix.SIMILAR_TEXT_THRESHOLD);
  assert.equal(mix.findSimilarText(1, lipB, '2026-10-14T07:16:00.000Z')?.scope, 'own');
  assert.equal(mix.findSimilarText(2, lipB, '2026-10-16T07:16:00.000Z')?.scope, 'cross');
  assert.equal(mix.findSimilarText(2, other, '2026-10-14T07:16:00.000Z'), null);
  assert.equal(mix.findSimilarText(2, lipB, '2026-10-25T07:16:00.000Z'), null, 'outside the 7-day window');
  assert.equal(mix.findSimilarText(4, lipB, '2026-10-14T07:16:00.000Z'), null, 'customers unaffected');
  clearPosts();
});

test('staggered schedule: 7 owner accounts on distinct offsets, 50-60 min gaps, 16 posts inside 08-23 KST', () => {
  ap.setAccountPersonaConfig({
    accounts: LIVE_ACCOUNTS,
    dailyPostsMin: 16,
    dailyPostsMax: 16,
    maxLinkedPerDay: 5,
    gapMinutesMin: 50,
    gapMinutesMax: 60,
    activeStartHour: 8,
    activeEndHour: 23,
    dedupeOwnDays: 7,
    staggerAccounts: true,
  });
  const days = new Map();
  const minutesByAccount = new Map();
  for (const id of OWNER_IDS) {
    const opts = slots.personaChainOptions(id);
    assert.equal(opts.stagger, true);
    const step = slots.chainStepper(id, 16, 0, () => 0, opts);
    const out = [];
    for (let s2 = step(); s2; s2 = step()) out.push(s2.getTime());
    for (let i = 0; i < out.length; i++) {
      const kstHour = new Date(out[i] + 9 * 3600000).getUTCHours();
      assert.ok(kstHour >= 8 && kstHour < 23, `#${id} slot at ${kstHour}h KST`);
      const day = slots.dayKeyKst(new Date(out[i]));
      if (i && slots.dayKeyKst(new Date(out[i - 1])) === day) {
        const gap = (out[i] - out[i - 1]) / 60000;
        assert.ok(gap >= 50 && gap <= 60, `#${id} gap ${gap}`);
      }
      const key = `${id}:${day}`;
      days.set(key, (days.get(key) || 0) + 1);
    }
    minutesByAccount.set(id, out);
  }
  // Every full future day holds exactly 16 posts per account.
  const tomorrow = slots.addDay(slots.dayKeyKst(), 1);
  for (const id of OWNER_IDS) assert.equal(days.get(`${id}:${tomorrow}`), 16, `#${id} tomorrow`);
  // Tomorrow, any two accounts' posts are at least 4 minutes apart.
  const all = [];
  for (const [id, out] of minutesByAccount)
    for (const t of out) if (slots.dayKeyKst(new Date(t)) === tomorrow) all.push([t, id]);
  all.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++)
    assert.ok(all[i][0] - all[i - 1][0] >= 4 * 60000, `#${all[i - 1][1]} and #${all[i][1]} too close`);
  // Start offsets spread across the hour.
  const offsets = OWNER_IDS.map(id => slots.personaChainOptions(id).offsetMin);
  assert.deepEqual(offsets, [0, 8, 16, 24, 31, 39, 47]);
  pinBaseConfig();
});

// 2026-10-21 persona revision: a rotating shared style is anchored to the account's one person, and
// "나만 …" self-ID questions (lowest-view shape on these accounts) are rejected.
test('identity anchor carries the fixed person facts and the real-person rules', () => {
  const solo = ap.ACCOUNT_PERSONAS.find(p => p.id === 'acct-solo-officetel');
  const block = ap.identityAnchorBlock(solo);
  assert.match(block, /혼자 산다/);
  assert.match(block, /이 사람 생활에 없으면 쓰지 않고/);
  assert.ok(block.includes(ap.REAL_PERSON_RULES));
  assert.equal(ap.identityAnchorBlock(null), '');
  for (const p of ap.ACCOUNT_PERSONAS) assert.ok(p.block.includes(ap.REAL_PERSON_RULES), p.id);
});

test('self-ID questions with 나만 are a voice problem; ordinary questions are not', () => {
  for (const t of ['설거지 미루는 거 나만 이래?', '이거 나만 몰랐던 거 아니지?', '나만 그런가 싶었음'])
    assert.ok(voiceProblems(t, { mode: 'product' }).includes('상투적 표현'), t);
  assert.ok(!voiceProblems('설거지 미루는 중\n\n다들 몰아서 해 바로 해?', { mode: 'product' }).includes('상투적 표현'));
});

// 2026-10-30 (marketing plan 5, owner reset order): morning-heavy slot template, spread text-only
// daily posts, and "남편" only on the one persona that lives with a husband.
test('slot template: fixed KST times per account, a few minutes apart, gaps never under 50 min', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/config/accountPersonas.json'), 'utf8'));
  ap.setAccountPersonaConfig(cfg);
  try {
    for (const id of OWNER_IDS) {
      const step = slots.chainStepper(id, cfg.dailyPostsMax, 0, () => 0, slots.personaChainOptions(id));
      const day = [];
      for (let i = 0; i < 60; i++) {
        const d = step();
        if (!d) break;
        if (slots.dayKeyKst(d) === slots.addDay(slots.dayKeyKst(), 1)) day.push(d.getTime());
      }
      assert.equal(day.length, cfg.slotTemplate.length, `account ${id}`);
      for (let i = 1; i < day.length; i++) assert.ok(day[i] - day[i - 1] >= 50 * 60000, `account ${id} gap ${i}`);
      const hour = t => new Date(t + 9 * 3600000).getUTCHours();
      const morning = day.filter(t => hour(t) >= 8 && hour(t) <= 10).length;
      const midday = day.filter(t => hour(t) >= 11 && hour(t) <= 21).length;
      assert.ok(morning >= 4 && midday <= morning, `account ${id} morning ${morning} midday ${midday}`);
    }
  } finally {
    ap.setAccountPersonaConfig(null);
  }
});

test('daily posts spread through the day instead of three in a row', () => {
  const kinds = [];
  let linked = 0,
    plain = 0,
    daily = 0;
  for (let i = 0; i < 10; i++) {
    const k = mix.decideSlotKind({ linked, plain, daily, maxLinked: 5, maxDaily: 3, dailyCap: 10 });
    kinds.push(k);
    if (k === 'linked') linked++;
    else if (k === 'daily') daily++;
    else plain++;
  }
  assert.equal(kinds.filter(k => k === 'daily').length, 3);
  const at = kinds.map((k, i) => (k === 'daily' ? i : -1)).filter(i => i >= 0);
  assert.ok(at[1] - at[0] >= 2 && at[2] - at[1] >= 2, kinds.join(' '));
});

test('only a persona living with a husband may write "남편"', () => {
  for (const id of OWNER_IDS) {
    const p = ap.accountPersonaFor(id);
    assert.equal(ap.bannedPhrasesFor(id).includes('남편'), !/남편/.test(p.family), p.id);
  }
  assert.equal(OWNER_IDS.filter(id => /남편/.test(ap.accountPersonaFor(id).family)).length, 1);
});
