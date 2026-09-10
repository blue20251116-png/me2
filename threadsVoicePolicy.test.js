'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./threadsVoicePolicy');

const count = s => Array.from(String(s)).length;

function assertThreadsShape(text) {
  const lines = String(text).split('\n');
  assert.ok(lines.length <= policy.MAX_LINES, `too many lines: ${lines.length}`);
  for (const line of lines) assert.ok(count(line) <= policy.MAX_LINE_CHARS, `line too long (${count(line)}): ${line}`);
}

test('persona is a Threads viral writer, not a source-faithful summarizer', () => {
  const guide = policy.voiceGuide();
  assert.match(guide, /스레드 전용 바이럴 작가/);
  assert.match(guide, /소재\/씨앗/);
  assert.match(guide, /리액션|비유|상황 연출/);
  assert.doesNotMatch(guide, /원문 90%|새 사건을 덧붙였는지|지어내지 않는다/);
});

test('hard format is a line-count ceiling, not a per-line character target', () => {
  const valid = '이거 처음 봤는데\n생각보다 훨씬 신기함\n마지막이 진짜 포인트';
  assertThreadsShape(policy.assertVoice(valid));

  // A real, complete Korean sentence can run well past what used to be a hard per-line cap —
  // this must be accepted whole, not rejected or force-split.
  const naturalLongLine = '사촌오빠가 밥먹다 말고 물고기 밥주러 가야된다고 함';
  assert.ok(count(naturalLongLine) > 24, 'fixture must exceed the old low cap to be a meaningful check');
  assert.ok(count(naturalLongLine) <= policy.MAX_LINE_CHARS);
  assert.deepEqual(policy.voiceProblems(naturalLongLine), []);

  const tooManyLines = Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}줄`).join('\n');
  assert.ok(policy.voiceProblems(tooManyLines).includes(`${policy.MAX_LINES}줄 초과`));
  assert.throws(() => policy.assertVoice(tooManyLines), { code: 'CONTENT_STYLE_REJECTED' });

  const wayTooLong = '가'.repeat(policy.MAX_LINE_CHARS + 1);
  assert.ok(policy.voiceProblems(wayTooLong).includes(`${policy.MAX_LINE_CHARS}자 초과`));
  assert.throws(() => policy.assertVoice(wayTooLong), { code: 'CONTENT_STYLE_REJECTED' });

  assert.equal(count('가나다😀'), 4, 'emoji must count as one Unicode code point');
});

test('blank-line paragraph breaks are allowed and count toward the line boundary', () => {
  const text = ['첫줄 생각 하나','','둘째 생각 하나','','셋째 생각 하나'].join('\n');
  assertThreadsShape(policy.assertVoice(text));
  assert.deepEqual(policy.voiceProblems(text), []);

  const parts = Array.from({length: policy.MAX_LINES}, (_, i) => (i % 2 === 0 ? `${i}번째 줄` : ''));
  if (!parts[parts.length - 1]) parts[parts.length - 1] = '마지막 줄'; // must not end on a blank line
  const atTheBoundary = parts.join('\n');
  assert.equal(atTheBoundary.split('\n').length, policy.MAX_LINES);
  assertThreadsShape(policy.assertVoice(atTheBoundary));
});

test('incomplete-line guard rejects only obvious fragments, not normal Korean beats', () => {
  assert.deepEqual(policy.incompleteLineReasons('이 조합은 의외인데\n먹어보면 바로 이해됨'), []);
  assert.deepEqual(policy.incompleteLineReasons('이거는\n진짜 신기함'), []);
  assert.deepEqual(policy.incompleteLineReasons('나는\n진짜 신기함'), []);
  assert.ok(policy.incompleteLineReasons('그리고\n진짜 신기함').length > 0);
  assert.ok(policy.incompleteLineReasons('하지만\n결과는 완전 다름').length > 0);
});

test('a bound-noun exclamation ("토할" / "뻔!") split across lines is caught and repaired, not shipped', () => {
  const broken = '올라오고... 진짜 토할\n뻔! 근데 이 세제';
  assert.ok(policy.incompleteLineReasons(broken).length > 0, 'must flag the mid-phrase split');
  assert.ok(policy.voiceProblems(broken).includes('미완결 줄바꿈'));
  const { repairConnectorOnlyBreaks } = require('./threadsVoiceLocalRepair');
  const fixed = repairConnectorOnlyBreaks(broken, policy.MAX_LINE_CHARS);
  assert.deepEqual(policy.incompleteLineReasons(fixed), []);
  assert.equal(fixed.split('\n').length, 1, 'the exclamation must end up on one line, not split');
});

test('formatter does not silently truncate or hard-wrap generated copy', () => {
  const long = '가'.repeat(45);
  assert.equal(policy.formatVoice(long), long);
  assert.throws(() => policy.assertVoice(long), { code: 'CONTENT_STYLE_REJECTED' });
});

test('runtime review repairs an overlong line instead of discarding the material', async () => {
  let calls = 0;
  const original = '이 뒤집개 하나 사고 나서부터는 프라이팬 요리가 진짜 몇 배로 편해졌음ㅋㅋ';
  assert.ok(count(original) > policy.MAX_LINE_CHARS, 'fixture must exceed the cap to exercise the repair path');
  const out = await policy.reviewSourceVoice(original, { mode: 'product', sourceText: '집게형 실리콘 뒤집개 영상' }, async () => {
    calls++;
    return { text: '집게랑 뒤집개가 합쳐짐\n요리할 때 진짜 편함' };
  });
  assert.equal(calls, 1);
  assert.equal(out, '집게랑 뒤집개가 합쳐짐\n요리할 때 진짜 편함');
  assertThreadsShape(out);
});

test('runtime review retries one more time when first format repair still fails', async () => {
  let calls = 0;
  const out = await policy.reviewSourceVoice('가'.repeat(45), { mode: 'product' }, async () => {
    calls++;
    if (calls === 1) return { text: '나'.repeat(45) };
    return { text: '이건 진짜 신기함\n써보면 바로 이해됨' };
  });
  assert.equal(calls, 2);
  assertThreadsShape(out);
});

test('runtime review is bounded and rejects after two failed repairs', async () => {
  let calls = 0;
  await assert.rejects(
    policy.reviewSourceVoice('가'.repeat(45), { mode: 'product' }, async () => {
      calls++;
      return { text: '나'.repeat(45) };
    }),
    { code: 'CONTENT_STYLE_REJECTED' }
  );
  assert.equal(calls, policy.MAX_FORMAT_REPAIR_ATTEMPTS);
});

test('a formulaic "너도 해봐~🙂" ad-CTA sign-off is rejected, even split across the last two lines', () => {
  const splitAcrossLines = '이거 진짜 신기함ㅋㅋ\n진짜 가능할 듯! 너도\n도전해봐~😊';
  assert.ok(policy.voiceProblems(splitAcrossLines).includes('뻔한 CTA 마무리'));
  assert.throws(() => policy.assertVoice(splitAcrossLines), { code: 'CONTENT_STYLE_REJECTED' });

  const sameLine = '이거 완전 신기함ㅋㅋ\n너도 한번 해봐~😆';
  assert.ok(policy.voiceProblems(sameLine).includes('뻔한 CTA 마무리'));

  assert.deepEqual(policy.voiceProblems('이거 진짜 신기함\n다음에도 또 봐야지'), []);
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
