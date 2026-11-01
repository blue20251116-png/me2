'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real SQLite in a throwaway data dir - never the live db/scheduler.db.
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-frames-'));

const { db } = require('../src/infra/db');
const frames = require('../src/content/postFrames');
const { voiceProblems } = require('../src/content/voicePolicy');
const mix = require('../src/autopilot/accountMix');
const aiCalls = require('../src/autopilot/aiCalls');

const OWNER_IDS = [1, 2, 3, 10, 11, 13, 14];
const CUSTOMER_IDS = [4, 6, 15, 16];
for (const id of [...OWNER_IDS, ...CUSTOMER_IDS])
  db.prepare('INSERT OR IGNORE INTO accounts (id,label) VALUES (?,?)').run(id, `acct${id}`);

const FRAME_A_POST =
  '쿠팡 뒤지다가 미친 가성비 칫솔 발견함ㄷㄷ\n\n70년 전통 장인이 만든 칫솔인데 2개입인 거 실화임? ;;\n\n보이면 무조건 쟁여둠!!';
const GROUNDED = { evidence: '70년 전통 장인이 만든 칫솔 2개입', price: 2000 };

test('frame choice alternates per account (fewer-used frame next, 50:50 on a tie)', () => {
  assert.equal(frames.chooseFrame({ A: 3, B: 2 }), 'B');
  assert.equal(frames.chooseFrame({ A: 1, B: 4 }), 'A');
  assert.equal(
    frames.chooseFrame({}, () => 0.2),
    'A'
  );
  assert.equal(
    frames.chooseFrame({ A: 2, B: 2 }, () => 0.7),
    'B'
  );
  // Simulated stream of posts stays balanced.
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 40; i++) counts[frames.chooseFrame(counts)]++;
  assert.deepEqual(counts, { A: 20, B: 20 });
});

test("chooseFrameFor reads this account's recorded post_frame history; customers get no frame", () => {
  db.prepare('DELETE FROM posts').run();
  const at = new Date(Date.now() - 3600000).toISOString();
  const ins = (id, f) =>
    db
      .prepare(`INSERT INTO posts (account_id,text,scheduled_at,status,post_frame) VALUES (?,?,?,'posted',?)`)
      .run(id, 't', at, f);
  ins(1, 'A');
  ins(1, 'A');
  ins(1, 'B');
  ins(2, 'B');
  assert.deepEqual(mix.frameCounts(1), { A: 2, B: 1 });
  assert.equal(mix.chooseFrameFor(1), 'B');
  assert.equal(mix.chooseFrameFor(2), 'A');
  for (const id of CUSTOMER_IDS) assert.equal(mix.chooseFrameFor(id), null);
  db.prepare('DELETE FROM posts').run();
});

test('place truthfulness: a store the source does not mention is rejected', () => {
  const post = '다이소 갔다가 미친 가성비 칫솔 발견함ㄷㄷ\n\n보이면 무조건 쟁여둠!!';
  assert.deepEqual(frames.storeProblems(post, '칫솔 2개입 부드러운 모'), ['근거 없는 장소:다이소']);
  assert.deepEqual(frames.storeProblems(post, '다이소에서 산 칫솔'), []);
  assert.ok(
    voiceProblems(post, { frame: 'A', grounding: { evidence: '칫솔', price: null } }).includes('근거 없는 장소:다이소')
  );
  assert.deepEqual(frames.storeProblems('쿠팡 뒤지다가 발견함', ''), []);
  // "무지" (very) is ordinary speech, not the store.
  assert.deepEqual(frames.storeProblems('무지 편함', ''), []);
});

test('authority/spec claims must come from the source post or product data', () => {
  assert.deepEqual(frames.authorityProblems(FRAME_A_POST, GROUNDED.evidence), []);
  const flagged = frames.authorityProblems(FRAME_A_POST, '칫솔 2개입');
  assert.ok(flagged.some(p => p.includes('장인')));
  assert.ok(flagged.some(p => p.includes('70년 전통')));
  assert.ok(frames.authorityProblems('판매량 1위라는데 이 가격', '칫솔').length >= 1);
  assert.deepEqual(frames.authorityProblems('인증샷 찍어둠', ''), []);
});

test('prices must match the Coupang product price (or a band containing it) or appear in the source', () => {
  assert.deepEqual(frames.priceProblems('2천 원인 거 실화임?', '', 2000), []);
  assert.deepEqual(frames.priceProblems('7천원대인데', '', 7480), []);
  assert.deepEqual(frames.priceProblems('990원인데', '', 2000), ['근거 없는 가격:990원']);
  assert.deepEqual(frames.priceProblems('990원인데', '원문에 990원이라고 나옴', null), []);
  assert.deepEqual(frames.priceProblems('2천 원짜리', '', null), ['근거 없는 가격:2천 원']);
});

test('frame A allows "미친 가성비/실화임/무조건 쟁여" but keeps every other ban', () => {
  assert.deepEqual(voiceProblems(FRAME_A_POST, { frame: 'A', grounding: GROUNDED }), []);
  // Same text without the frame (or as frame B, or for customers) is still rejected.
  assert.ok(voiceProblems(FRAME_A_POST).includes('상투적 표현'));
  assert.ok(voiceProblems(FRAME_A_POST).includes('광고 문구'));
  assert.ok(voiceProblems(FRAME_A_POST, { frame: 'B', grounding: GROUNDED }).includes('상투적 표현'));
  const hype = '쿠팡 뒤지다가 미친 가성비 발견함\n\n이건 진짜 인생템임\n\n보이면 무조건 쟁여둠!!';
  assert.ok(voiceProblems(hype, { frame: 'A', grounding: GROUNDED }).includes('광고 문구'));
  const readerCta = '쿠팡 뒤지다가 미친 가성비 발견함\n\n2개입인 거 실화임?\n\n너도 한번 사봐';
  assert.ok(voiceProblems(readerCta, { frame: 'A', grounding: GROUNDED }).includes('뻔한 CTA 마무리'));
  const bait = '쿠팡 뒤지다가 미친 가성비 발견함\n\n2개입인 거 실화임?\n\n궁금하면 댓글 달아줘';
  assert.ok(voiceProblems(bait, { frame: 'A', grounding: GROUNDED }).includes('참여 낚시'));
});

test('postWriter: owner product posts get a frame block and no price, recipes and customers get none', async () => {
  const calls = [];
  const original = aiCalls.callAiText;
  aiCalls.callAiText = async (_id, system, user) => {
    calls.push({ system, user });
    return { text: '싱크대 배수구 냄새 올라오면 진짜 신경 쓰임\n\n덮개 하나 바꾸고 나서 조용해짐', commentLead: '' };
  };
  delete require.cache[require.resolve('../src/autopilot/postWriter')];
  const { generatePost } = require('../src/autopilot/postWriter');
  const base = {
    material: { sourceText: '배수구 냄새 차단 덮개', authorReplies: '' },
    product: { name: '배수구 냄새 차단 덮개', price: 5900 },
    target: '전체',
  };
  try {
    db.prepare('DELETE FROM posts').run();
    const owner = await generatePost(3, { ...base, analysis: { mode: 'product', topic: '배수구', vision: {} } });
    assert.ok(['A', 'B'].includes(owner.frame));
    assert.ok(calls.at(-1).system.includes(frames.FRAMES[owner.frame].block.split('{{OPENING_HINT}}')[0]));
    assert.ok(!calls.at(-1).system.includes('{{OPENING_HINT}}'), 'opening hint filled in');
    assert.ok(!/5900/.test(calls.at(-1).user), 'price never reaches the writer');
    assert.equal(owner.grounding.price, 5900);

    const recipe = await generatePost(3, { ...base, analysis: { mode: 'recipe', topic: '배수구', vision: {} } }).catch(
      e => e
    );
    // Recipe posts may fail the recipe-comment repair with this fake AI; either way no frame was used.
    assert.ok(!calls.at(-1).system.includes('[이번 글의 구조'));
    if (!(recipe instanceof Error)) assert.equal(recipe.frame, null);

    for (const id of CUSTOMER_IDS) {
      const out = await generatePost(id, { ...base, analysis: { mode: 'product', topic: '배수구', vision: {} } });
      assert.equal(out.frame, null);
      assert.ok(!calls.at(-1).system.includes('[이번 글의 구조'));
      assert.ok(!calls.at(-1).user.includes('쿠팡 상품 가격'));
    }
  } finally {
    aiCalls.callAiText = original;
    delete require.cache[require.resolve('../src/autopilot/postWriter')];
  }
});

test('owner rule 2026-10-24: any price in a Threads post or comment is flagged', () => {
  const { priceMention, voiceProblems: vp } = require('../src/content/voicePolicy');
  for (const t of ['2천 원짜리 하나 삼', '15650원이라 놀람', '7천원대인데', '3만원 넘게 씀', '가격 보고 놀람', '이 값이면 진작 살 걸'])
    assert.ok(priceMention(t), t);
  for (const t of ['4시간 재우기', '믹스 4개 넣음', '3원칙만 지킴', '30cm짜리 깔고 누움']) assert.ok(!priceMention(t), t);
  assert.ok(vp('퇴근하고 바닥에 누움\n\n17700원이라 두 번 봄').includes('가격 언급'));
  assert.ok(vp('가격은 3천원대', { comment: true }).includes('가격 언급'));
});
