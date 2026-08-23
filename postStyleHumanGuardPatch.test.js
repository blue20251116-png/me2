'use strict';

// Lightweight regression examples for manual/local verification.
// Loading the patch also wraps the engine, so this file is intentionally not part of npm start.
const { inspect } = require('./postStyleHumanGuardPatch');

const cases = [
  ['empty AI sentiment', '이제 꿀 없이는 못 살 것 같은 느낌 ㅋㅋ\n진짜 꿀은 그냥 꿀이 아닌 듯', true],
  ['invented relation', '친구가 그렇게 행복해 보이다니\n대체 꿀이 뭘까', true],
  ['reaction overuse', '와 ㅋㅋㅋ\n이건 ㅎㅎ\n진짜 ㅁㅊ', true],
  ['natural short reaction', '눈 저렇게 부었는데\n꿀은 끝까지 먹고 있네ㅋㅋ\n진짜 포기를 모르네', false]
];

for (const [name, text, shouldReject] of cases) {
  const reasons = inspect(text);
  const rejected = reasons.length > 0;
  if (rejected !== shouldReject) {
    throw new Error(`${name}: expected reject=${shouldReject}, got ${rejected}, reasons=${reasons.join(',')}`);
  }
}

console.log('postStyleHumanGuardPatch regression checks PASS');
