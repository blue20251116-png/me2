'use strict';
// 2026-11-05 daily review: (1) first-person purchase claims go to the rewrite step and are rejected if
// they stay, (2) Coupang-link posts carry a disclosure line in the BODY (outside the 100-char limit),
// (3) a posted auto-comment is read back to fill comment_verified_at.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// threadsApi loads the DB module: never the live db/scheduler.db.
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-review1105-'));
process.env.ME2_SECRET_KEY = 'review-1105-test-key';
const policy = require('../src/content/voicePolicy');
const { withBodyDisclosure, BODY_COUPANG_DISCLOSURE, DEFAULT_COUPANG_DISCLOSURE } = require('../src/publish/commentText');
const frames = require('../src/content/postFrames');

const CLAIMS = [
  '엄마 것까지 하나 더 주문함', // 8713
  '한 봉지 금방 비워서 하나 더 주문함', // 8742
  '주말 아들 만들기 영상용으로 주문함', // 8759
  '장바구니에 넣었다 뺐다 세 번 하다가 결국 주문함',
  '써보고 나서 하나 더 주문한 거 처음임',
  '자기 전에 폰 보다가 결국 결제 버튼 누름',
  '장 보다가 넣을까 말까 하던 거 결국 삼',
  '수영장 가방에 넣을까 말까 하던 발크림 삼',
  '세일하길래 두 개 질렀음',
  '어제 하나 샀는데 괜찮음',
  '한 통 더 사러 감ㅋㅋ',
  '진작 살걸',
  '6개입 세트로 구매했음',
  '일단 장바구니에 담아둠',
];
const NOT_CLAIMS = [
  '핑크 미니 다리미로 3분 문질렀더니 펴지더라',
  '스틱 달린 크림으로 박박 문질러봄',
  '살까 말까 일주일 고민 중',
  '보이면 무조건 쟁여둠!!',
  '홍삼 한 포 먹고 출근',
  '원룸 수납 고민인 분은 참고',
  '주문 들어가면 이틀이면 온다더라',
];

test('purchase claims are flagged; ordinary lines are not', () => {
  for (const t of CLAIMS) assert.ok(policy.purchaseClaim(t), t);
  for (const t of NOT_CLAIMS) assert.ok(!policy.purchaseClaim(t), t);
  const post = '국물 위 기름 건지다 국이 다 식음ㅋㅋㅋ\n\n스테인레스 국자 하나로 1초 만에 싹 걷힘\n진작 쓸 걸...\n\n일단 한 개 더 주문함';
  assert.ok(policy.voiceProblems(post).includes('구매 경험 주장'));
  assert.throws(() => policy.assertVoice(post), { code: 'CONTENT_STYLE_REJECTED' });
});

test('a purchase claim is sent to the rewrite step, and the rewrite is accepted when the claim is gone', async () => {
  const post = '국물 위 기름 건지다 국이 다 식음ㅋㅋㅋ\n\n스테인레스 국자 하나로 1초 만에 싹 걷힘\n\n일단 한 개 더 주문함';
  const prompts = [];
  const out = await policy.reviewSourceVoice(post, {}, async (system, user) => {
    prompts.push({ system, user });
    return { text: '국물 위 기름 건지다 국이 다 식음ㅋㅋㅋ\n\n스테인레스 국자 하나로 1초 만에 싹 걷힘\n\n국 자주 끓이는 집은 참고' };
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].user, /구매 경험 주장/);
  assert.match(prompts[0].system, /"구매 경험 주장"이 수정 대상에 있으면/);
  assert.ok(!policy.purchaseClaim(out));
  assert.deepEqual(policy.voiceProblems(out), []);
  // A rewrite that keeps claiming the purchase is rejected, not published.
  await assert.rejects(
    policy.reviewSourceVoice(post, {}, async () => ({ text: post })),
    { code: 'CONTENT_STYLE_REJECTED' }
  );
});

test('frame A prompt and openers no longer model purchases', () => {
  const block = frames.frameBlock('A', () => 0);
  assert.doesNotMatch(block, /엄마 것까지 하나 더 주문함/);
  for (const o of frames.FRAME_A_OPENINGS) assert.ok(!policy.purchaseClaim(o), o);
});

test('owner 11/08: by default the body is sent unchanged (disclosure only in the comment)', () => {
  const prev = process.env.ME2_BODY_DISCLOSURE;
  delete process.env.ME2_BODY_DISCLOSURE;
  const body = '퇴근하고 바닥에 누움\n\n폭신해서 그대로 잠듦';
  assert.equal(withBodyDisclosure(body, 'https://link.coupang.com/a/abc123'), body);
  if (prev !== undefined) process.env.ME2_BODY_DISCLOSURE = prev;
});

test('ME2_BODY_DISCLOSURE=1: Coupang-link posts get the disclosure as the last body line; other posts are untouched', () => {
  process.env.ME2_BODY_DISCLOSURE = '1';
  const body = '퇴근하고 바닥에 누움\n\n폭신해서 그대로 잠듦';
  const out = withBodyDisclosure(body, 'https://link.coupang.com/a/abc123');
  assert.equal(out, `${body}\n\n${BODY_COUPANG_DISCLOSURE}`);
  assert.equal(out.split('\n').pop(), '쿠팡 파트너스 활동으로 수수료를 받을 수 있음');
  assert.equal(withBodyDisclosure(body, ''), body);
  assert.equal(withBodyDisclosure(body, 'https://example.com/x'), body);
  // Not added twice (old rows that already carry a disclosure, or a retried publish).
  assert.equal(withBodyDisclosure(out, 'https://link.coupang.com/a/abc123'), out);
  assert.equal(withBodyDisclosure(`${body}\n\n${DEFAULT_COUPANG_DISCLOSURE}`, 'https://www.coupang.com/vp/1').split('쿠팡 파트너스').length, 2);
  // Threads' 500-char limit.
  assert.throws(() => withBodyDisclosure('가'.repeat(490), 'https://link.coupang.com/a/x'), /500자/);
  delete process.env.ME2_BODY_DISCLOSURE;
});

test("the account's 100-char body limit is counted without the disclosure line", () => {
  process.env.ME2_BODY_DISCLOSURE = '1';
  // A body right at the ceiling passes the writer's check; the disclosure is added only at publish time.
  const body = '서랍 세 칸이 한 번에 정리되니까 신기함\n방 어질러놓는 게 습관이었는데 그날 두 칸이나 비웠잖아\n\n이번 주말엔 안방 옷장까지 해볼 생각임';
  assert.ok(Array.from(body).length <= policy.MAX_BODY_CHARS);
  assert.ok(!policy.bodyTooLong(body));
  const published = withBodyDisclosure(body, 'https://link.coupang.com/a/x');
  assert.ok(Array.from(published).length > Array.from(body).length);
  assert.ok(Array.from(published).length <= 500);
  delete process.env.ME2_BODY_DISCLOSURE;
});

test('replyCheck: a reply under the right post is verified; missing, top-level or misplaced ones are not', () => {
  const { replyCheck } = require('../src/threads/threadsApi');
  assert.deepEqual(replyCheck({ id: 'c1', is_reply: true, replied_to: { id: 'p1' }, permalink: 'https://www.threads.net/@a/post/X' }, 'c1', 'p1'), {
    verified: true,
    permalink: 'https://www.threads.net/@a/post/X',
    reason: '',
  });
  assert.equal(replyCheck({ id: 'c1', is_reply: true, root_post: { id: 'p1' } }, 'c1', 'p1').verified, true);
  assert.equal(replyCheck({ id: 'c1', is_reply: true }, 'c1', 'p1').verified, true);
  assert.equal(replyCheck({ id: 'c1', is_reply: false }, 'c1', 'p1').reason, 'COMMENT_NOT_A_REPLY');
  assert.equal(replyCheck({ id: 'c1', is_reply: true, replied_to: { id: 'p9' } }, 'c1', 'p1').reason, 'COMMENT_UNDER_OTHER_POST');
  assert.equal(replyCheck({}, 'c1', 'p1').reason, 'COMMENT_NOT_FOUND');
});
