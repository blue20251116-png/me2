'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./threadsVoicePolicy');

const count = s => Array.from(String(s)).length;

function assertThreadsShape(text) {
  const lines = String(text).split('\n');
  assert.ok(lines.length <= 10, `too many lines: ${lines.length}`);
  for (const line of lines) assert.ok(count(line) <= 18, `line too long (${count(line)}): ${line}`);
}

test('persona is a Threads viral writer, not a source-faithful summarizer', () => {
  const guide = policy.voiceGuide();
  assert.match(guide, /스레드 전용 바이럴 작가/);
  assert.match(guide, /소재\/씨앗/);
  assert.match(guide, /리액션|비유|상황 연출/);
  assert.doesNotMatch(guide, /원문 90%|새 사건을 덧붙였는지|지어내지 않는다/);
});

test('hard format is maximum ten lines and eighteen Unicode code points per line', () => {
  const valid = '이거 처음 봤는데\n생각보다 훨씬 신기함\n마지막이 진짜 포인트';
  assertThreadsShape(policy.assertVoice(valid));

  const eleven = Array.from({length: 11}, (_, i) => `${i}줄`).join('\n');
  assert.ok(policy.voiceProblems(eleven).includes('10줄 초과'));
  assert.throws(() => policy.assertVoice(eleven), { code: 'CONTENT_STYLE_REJECTED' });

  const nineteen = '가'.repeat(19);
  assert.ok(policy.voiceProblems(nineteen).includes('18자 초과'));
  assert.throws(() => policy.assertVoice(nineteen), { code: 'CONTENT_STYLE_REJECTED' });

  assert.equal(count('가나다😀'), 4, 'emoji must count as one Unicode code point');
});

test('blank lines count toward the ten-line publishing boundary', () => {
  const text = ['첫줄','','둘째','','셋째','','넷째','','다섯째','마지막'].join('\n');
  assert.equal(text.split('\n').length, 10);
  assertThreadsShape(policy.assertVoice(text));
});

test('formatter does not silently truncate or hard-wrap generated copy', () => {
  const long = '가'.repeat(19);
  assert.equal(policy.formatVoice(long), long);
  assert.throws(() => policy.assertVoice(long), { code: 'CONTENT_STYLE_REJECTED' });
});

test('old style blacklist is gone while safety checks remain', () => {
  for (const expressive of [
    '여러분은 어때?',
    '대박임 ㅋㅋ',
    '강력 추천',
    '원문에서는 이렇대',
    'ㅋㅋㅋㅋㅋㅋ',
  ]) assert.deepEqual(policy.voiceProblems(expressive), []);

  assert.ok(policy.voiceProblems('한 달 만에 12kg 빠졌어').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('이거 먹으면 암이 치료돼').includes('고위험 효능 주장'));
});

test('source is a creative seed: invented low-risk connective copy is allowed', async () => {
  const text = '처음엔 별거 아닌데\n보다가 계속 보게 됨ㅋㅋ';
  const out = await policy.reviewSourceVoice(text, { sourceText: '금붕어가 먹이를 먹는 영상' }, async () => {
    throw new Error('low-risk creative copy should not require source-faithful semantic audit');
  });
  assert.equal(out, text);
});

test('health claims still use a separate factual safety audit', async () => {
  let calls = 0;
  await assert.rejects(
    policy.reviewSourceVoice('이 동작이면\n허리통증이 치료됨', { sourceText: '허리 스트레칭 영상' }, async () => {
      calls++;
      return { issues: ['치료 효과 근거 없음'], sourceAnchors: [] };
    }),
    { code: 'CONTENT_STYLE_REJECTED' }
  );
  assert.ok(calls >= 1);
});

test('recipe comment reveal is conditional, not a global requirement', () => {
  const body = '계란찜에 이거 넣음\n맛이 확 달라짐ㅋㅋ\n비밀재료는 댓글에';
  assertThreadsShape(policy.assertVoice(body, { mode: 'recipe' }));
  assert.deepEqual(policy.voiceProblems('그냥 신기한 영상임', { mode: 'product' }), []);
});

test('short posts are valid; ten lines are never mandatory', () => {
  for (const text of ['이거 뭐임ㅋㅋ', '처음엔 평범했는데\n마지막이 미쳤음', '이거 하나로 끝']) {
    assertThreadsShape(policy.assertVoice(text));
  }
});
