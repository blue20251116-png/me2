'use strict';
// Grounded in real account data: four autopilot posts that got almost no views, versus the shape
// of shopping posts that reach tens of thousands of views on Korean Threads (someone/somewhere +
// the original worry + one number + a reaction, no ad copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceProblems, voiceGuide } = require('../src/content/voicePolicy');
const { PERSONAS } = require('../src/content/personas');
const { normalizeVisionResult, mediaFlagSkipReason } = require('../src/autopilot/vision');

const LOW_VIEW_POSTS = {
  sofa: `좁은 집에서 살다 보니 소파랑 매트리스 따로 사면 후회할 일 많더라ㅋㅋ

이거 하나면 거실 분위기도 살고,
손님 오면 편하게 침대까지 된다니 완전 대박임

진짜 이거 등받이만 쫙 펼치면 푹신한 침대로 변신함

이거 놓기만 해도 집이 확 바뀌는 느낌인데,
빈티지 가죽의 멋스러움이 또 장난 아님

이거 없으면 이제 못 살 듯...`,
  dogTreat: `리트리버가 다리 마비된 척 하더니
닭다리 하나에 벌떡 일어났어ㅋㅋ

입맛 까다로운 댕댕이도 반하는 간식이래
이걸 먹이고 나면 다들 같은 반응이지

이거 하나면 강아지들이 완전 미쳐버려!`,
  wallet: `일본 여행 준비하면서 이 지갑 발견했는데, 내부 공간 진짜 넉넉하다;;
지갑이 뚱뚱해지는 거 싫은 사람들, 이거 꼭 써봐야 해!!

색상도 다양하고,
쿠폰에 따라 가격도 달라지니까 확인 필수!!`,
  snack: `아이스크림 콘 끝부분만 모아둔 과자 발견함!

한 입에 털어 넣으니까 달달함이 미쳐버림ㅋㅋ

다이어트 또 실패했네

지퍼백이라 눅눅해질 틈이 없고,
책상에 두고 먹다 보면 바닥남

한 번 먹으면 멈출 수가 없음

이 맛이 대체 뭐길래?`,
};

test('the low-view autopilot posts are all rejected as ad copy', () => {
  for (const [name, text] of Object.entries(LOW_VIEW_POSTS)) {
    assert.ok(voiceProblems(text).includes('광고 문구'), name);
  }
  assert.ok(voiceProblems(LOW_VIEW_POSTS.sofa).includes('이거 반복'));
  assert.ok(voiceProblems(LOW_VIEW_POSTS.snack).includes('문단 과다'));
});

test('posts in the shape that travels pass, strong words about my own scene included', () => {
  const good = [
    `회사 선배가 다이소 거라고 알려줌
책상 밑 전선 정리 매번 포기했었는데

3천원짜리 케이블 트레이 하나 붙였더니 발밑이 싹 비었음
옆자리 사람도 어디서 샀냐고 물어봄ㅋㅋ`,
    `김치찌개가 뭐 얼마나 달라지겠어 했거든?

시어머니가 알려준 대로 들기름 한 숟갈 먼저 볶았더니
남편이 말없이 두 그릇째 퍼감

들기름 한 병 더 사러 간다;;`,
    `동네 국숫집 사장님은 진짜 미친 사람인가;;
지금까지 먹어본 비빔국수 통틀어서 원탑임

이제 밖에서 비빔면 사 먹는 짓 안 함
양념 비율 따라 했더니 4인분에 5천원 들었음`,
    `애 낮잠 30분이면 깨던 사람 나야 나

암막 커튼 바꾸고 2시간 자는 날이 생김ㅠㅠ
다들 낮잠 몇 분 자?`,
  ];
  for (const text of good) assert.deepEqual(voiceProblems(text), [], text);
});

test('the writing prompt no longer tells any persona to exaggerate', () => {
  for (const persona of PERSONAS) {
    const guide = voiceGuide(persona.block);
    assert.doesNotMatch(guide, /자극적인 쪽을 고른다|부풀려도 된다|무조건 더 센 쪽/, persona.id);
    assert.doesNotMatch(guide, /이거 진짜 인생템|게임 체인저"? 처럼 확실한|반응 미쳤음|이거 레전드/, persona.id);
    assert.match(guide, /주변 사람의 반응/, persona.id);
  }
});

test('vision reports burned-in ad labels and watermarks so the source can be skipped', () => {
  assert.deepEqual(normalizeVisionResult({ mediaFlags: { adLabel: true } }).mediaFlags, {
    adLabel: true,
    watermark: false,
  });
  assert.deepEqual(normalizeVisionResult({}).mediaFlags, { adLabel: false, watermark: false });
});

// Production 2026-10-01: adLabel fired on about half of all candidates (the affiliate disclosure text
// reads as an "ad label"), with watermark=false every time, and publishing nearly stopped.
test('only a watermark drops a source by default; adLabel needs AUTOPILOT_SKIP_AD_LABEL=1', () => {
  assert.equal(mediaFlagSkipReason({ adLabel: true, watermark: false }, {}), null);
  assert.match(mediaFlagSkipReason({ adLabel: false, watermark: true }, {}), /워터마크/);
  assert.match(mediaFlagSkipReason({ adLabel: true }, { AUTOPILOT_SKIP_AD_LABEL: '1' }), /광고 표시/);
  assert.equal(mediaFlagSkipReason(undefined, {}), null);
});
