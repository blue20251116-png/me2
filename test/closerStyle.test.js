'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { closerStyleFor, closerBlock, CLOSER_STYLES } = require('../src/content/accountPersonas');
const { voiceProblems } = require('../src/content/voicePolicy');

test('closer style rotates per account and hour through three forms', () => {
  const h = 3600000;
  const seen = new Set([closerStyleFor(1, 0), closerStyleFor(1, h), closerStyleFor(1, 2 * h)]);
  assert.equal(seen.size, 3);
  assert.notEqual(closerStyleFor(1, 0), closerStyleFor(2, 0));
  for (const s of Object.keys(CLOSER_STYLES)) assert.match(closerBlock(s), /마무리 방식/);
  assert.equal(closerBlock('nope'), '');
});

test('reaction/ongoing closers reject a question or 다들 last line; question closer allows it', () => {
  const q = '냄비에 물 1L 붓고 떡 400g 넣는 중\n\n정호영 셰프 영상 보고 따라 했는데\n마지막에 하나 넣었더니 옛날 분식집 맛이 남\n\n다들 떡볶이 국물 자작파야 넉넉파야?';
  assert.ok(voiceProblems(q, { closerStyle: 'reaction' }).includes('마무리 방식'));
  assert.ok(voiceProblems(q, { closerStyle: 'ongoing' }).includes('마무리 방식'));
  assert.ok(!voiceProblems(q, { closerStyle: 'question' }).includes('마무리 방식'));
  assert.ok(!voiceProblems(q, {}).includes('마무리 방식'));
  const r = '냄비에 물 1L 붓고 떡 400g 넣는 중\n\n정호영 셰프 영상 보고 따라 했는데\n마지막에 하나 넣었더니 옛날 분식집 맛이 남\n\n아들이 두 그릇째 퍼 가는 중';
  assert.ok(!voiceProblems(r, { closerStyle: 'reaction' }).includes('마무리 방식'));
});
