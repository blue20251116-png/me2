'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./threadsVoicePolicy');

const count = s => Array.from(String(s)).length;

function assertThreadsShape(text) {
  const lines = String(text).split('\n');
  assert.ok(lines.length <= policy.MAX_LINES, `too many lines: ${lines.length}`);
}

test('persona is a Threads viral writer, not a source-faithful summarizer', () => {
  const guide = policy.voiceGuide();
  assert.match(guide, /스레드 전용 바이럴 작가/);
  assert.match(guide, /소재\/씨앗/);
  assert.match(guide, /리액션|비유|상황 연출/);
  assert.doesNotMatch(guide, /원문 90%|새 사건을 덧붙였는지|지어내지 않는다/);
});

test('hard format is a line-count ceiling - there is no per-line character limit at all', () => {
  const valid = '이거 처음 봤는데\n생각보다 훨씬 신기함\n마지막이 진짜 포인트';
  assertThreadsShape(policy.assertVoice(valid));

  // A real, complete Korean sentence can run arbitrarily long - it must be accepted whole, never
  // rejected or force-split just for length. A fixed per-line character cap used to reject any
  // line over 40 chars regardless of whether it was one complete sentence, directly contradicting
  // this file's own rule ("줄은 글자수가 아니라 완결된 문장·절 단위로 나눈다"). Length alone is no
  // longer a rejection reason - only whether a line is a complete sentence/clause matters.
  const naturalLongLine = '사촌오빠가 밥먹다 말고 물고기 밥주러 가야된다고 함';
  assert.ok(count(naturalLongLine) > 24, 'fixture must exceed the old low cap to be a meaningful check');
  assert.deepEqual(policy.voiceProblems(naturalLongLine), []);

  const wayLongerThanTheOldCap = '이 세제 하나 사고 나서부터는 진짜 매번 손빨래하던 얼룩진 옷들이 거짓말처럼 깨끗해져서 신세계임';
  assert.ok(count(wayLongerThanTheOldCap) > 40, 'fixture must exceed the old removed cap to be a meaningful check');
  assert.deepEqual(policy.voiceProblems(wayLongerThanTheOldCap), []);
  assert.equal(policy.assertVoice(wayLongerThanTheOldCap), wayLongerThanTheOldCap);

  const tooManyLines = Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}줄`).join('\n');
  assert.ok(policy.voiceProblems(tooManyLines).includes(`${policy.MAX_LINES}줄 초과`));
  assert.throws(() => policy.assertVoice(tooManyLines), { code: 'CONTENT_STYLE_REJECTED' });

  assert.equal(count('가나다😀'), 4, 'emoji must count as one Unicode code point');
});

test('formatVoice never truncates or hard-wraps generated copy, however long a single line is', () => {
  const long = '가'.repeat(60);
  assert.equal(policy.formatVoice(long), long);
  assert.deepEqual(policy.voiceProblems(long), []);
  assert.equal(policy.assertVoice(long), long);
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

test('connector-only guard also catches 그니까/그러니까, not just 그리고/근데/그래서', () => {
  // Regression: 그니까 (casual) / 그러니까 (formal) are grammatically dependent connectives in
  // the exact same family as 그래서/근데 - always require a following clause, never a complete
  // standalone utterance - but were missing from CONNECTOR_ONLY entirely.
  assert.ok(policy.incompleteLineReasons('이거 완전 신기함ㅋㅋ\n그니까\n한번 써봐야될듯').length > 0);
  assert.ok(policy.incompleteLineReasons('가격도 착함\n그러니까\n더 고민할 필요가 없음').length > 0);
  const { repairConnectorOnlyBreaks } = require('./threadsVoiceLocalRepair');
  const fixed = repairConnectorOnlyBreaks('이거 완전 신기함ㅋㅋ\n그니까\n한번 써봐야될듯', policy.MAX_LINE_CHARS);
  assert.deepEqual(policy.incompleteLineReasons(fixed), []);
});

test('connector-only guard does not flag words that can stand alone as a complete reaction', () => {
  // 그치/그럼/아니 look connector-shaped but each also works as a genuine standalone
  // interjection ("그치" = "right?", "그럼" = "of course!", "아니" = "no way!"), so they must
  // stay out of CONNECTOR_ONLY - unlike 그래서/그니까, a bare line consisting only of one of
  // these is not itself proof of a cut-off sentence.
  assert.deepEqual(policy.incompleteLineReasons('이거 완전 좋았음\n그치\n네 말이 맞아'), []);
  assert.deepEqual(policy.incompleteLineReasons('가는거 맞지\n그럼\n같이 준비하자'), []);
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

test('the local repair pass shares the same bound-noun regex as detection, not a stale copy', () => {
  // Regression: threadsVoiceLocalRepair.js used to keep its own copy of
  // DANGLING_BOUND_NOUN_START (and the other two line-guard regexes) instead
  // of importing from threadsVoiceLineGuards.js. When that regex was widened
  // to catch 만큼/정도 with a trailing particle (see the test above this
  // one), the repair copy never got the update - so voiceProblems() flagged
  // a "정도로"-led split as broken, but repairConnectorOnlyBreaks() silently
  // failed to merge it back (returned the text unchanged), because its own
  // stale regex didn't recognize "정도" at all.
  const broken = '진짜 놀랄 정도\n정도로 맛있었음';
  assert.ok(policy.voiceProblems(broken).includes('미완결 줄바꿈'), 'must be flagged as broken');
  const { repairConnectorOnlyBreaks } = require('./threadsVoiceLocalRepair');
  const fixed = repairConnectorOnlyBreaks(broken, policy.MAX_LINE_CHARS);
  assert.deepEqual(policy.voiceProblems(fixed), [], 'the repair must actually fix what detection flagged');
  assert.equal(fixed.split('\n').length, 1, 'the split bound-noun phrase must end up merged onto one line');
});

test('bound-noun detection is not fooled by ordinary words that share a first syllable', () => {
  // Synthetic-sentence check: 채, 리, 참, 겸, 셈, 법 are bound nouns only when they stand
  // bare before punctuation - as the first syllable of an ordinary word (채소, 리뷰, 참고,
  // 겸사겸사, 셈이다, 법적으로) they must NOT be flagged as a dangling split.
  const safe = [
    '오늘 장 보고 왔는데\n채소를 많이 샀음ㅋㅋ',
    '이거 써보고\n리뷰 남겨볼게',
    '가격 보고\n참고로 말하면 반값 세일함',
    '청소하고\n겸사겸사 정리도 했음',
    '이거\n법적으로 문제없다고 하더라',
    '어차피 사려고 했던\n셈이니까 잘됐다',
    '집에 와서\n정리하고 씻었음',
  ];
  for (const text of safe) assert.deepEqual(policy.incompleteLineReasons(text), [], `false positive on: ${text}`);
});

test('bound nouns with a trailing particle (만큼이나, 정도로) are still caught as a dangling split', () => {
  // Regression: real generated text almost always attaches a particle straight onto 만큼/정도
  // ("만큼이나", "정도로") rather than leaving it bare before punctuation - the original bound-noun
  // check missed all of these, and 정도 itself was missing from the list entirely.
  const broken = [
    '이거\n만큼이나 좋아함',
    '먹을\n만큼만 담았음',
    '한 박스 다 먹을\n만큼 맛있음',
    '소름 돋을\n정도로 좋음',
    '살 뺀\n정도는 아니지만',
  ];
  for (const text of broken) assert.ok(policy.incompleteLineReasons(text).length > 0, `should flag: ${text}`);
});

test('runtime review repairs a too-many-lines post instead of discarding the material', async () => {
  // Fixture updated: an overlong single line used to be a rejection reason on its own and was
  // this test's trigger, but length alone no longer gates rejection - too-many-lines still does,
  // so that's what exercises the same repair path here now.
  let calls = 0;
  const original = Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}번째 줄`).join('\n');
  assert.ok(policy.voiceProblems(original).includes(`${policy.MAX_LINES}줄 초과`), 'fixture must actually trigger a rejection to exercise the repair path');
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
  const tooManyLines = Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}번째 줄`).join('\n');
  const out = await policy.reviewSourceVoice(tooManyLines, { mode: 'product' }, async () => {
    calls++;
    if (calls === 1) return { text: Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}번`).join('\n') };
    return { text: '이건 진짜 신기함\n써보면 바로 이해됨' };
  });
  assert.equal(calls, 2);
  assertThreadsShape(out);
});

test('runtime review is bounded and rejects after two failed repairs', async () => {
  let calls = 0;
  const tooManyLines = Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}번째 줄`).join('\n');
  await assert.rejects(
    policy.reviewSourceVoice(tooManyLines, { mode: 'product' }, async () => {
      calls++;
      return { text: Array.from({length: policy.MAX_LINES + 1}, (_, i) => `${i}번`).join('\n') };
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

test('the ad-CTA guard catches "너도 <verb>봐" for verbs other than 해/써, not just the two named as examples', () => {
  // Regression: voiceGuide() only *names* 해봐/도전해봐/써봐 as illustrative examples of the
  // banned CTA shape ("너도 해봐, 너도 도전해봐, 너도 써봐처럼"), but the old regex hardcoded
  // exactly those verb stems - so the identical formulaic CTA slipped through untouched for
  // every other verb this bot's product categories actually use: 발라봐 (skincare), 만들어봐/
  // 먹어봐 (food/recipe), 사봐 (a general purchase nudge), 들어봐 (media).
  for (const verbEnding of ['너도 발라봐~😊', '너도 만들어봐~', '너도 사봐!', '너도 먹어봐~', '너도 들어봐', '너도 발라보길']) {
    const post = '이거 진짜 좋았음\n' + verbEnding;
    assert.ok(policy.voiceProblems(post).includes('뻔한 CTA 마무리'), `should catch: "${verbEnding}"`);
  }
});

test('the generalized ad-CTA guard does not flag ordinary sentences that merely contain "너도"', () => {
  for (const safe of ['이거 너도 볼래?', '너도 알다시피 이게 국내산이야', '이건 나만 아는 거 아니고 너도 알아둬']) {
    const post = '완전 신기했음\n' + safe;
    assert.deepEqual(policy.voiceProblems(post).filter(r => r === '뻔한 CTA 마무리'), [], `should not catch: "${safe}"`);
  }
});

test('the persona guide never recommends the exact CTA pattern it also bans', () => {
  const guide = policy.voiceGuide();
  // The closing-pattern example list once suggested "너도 꼭 써봐!" as a good ending while a
  // later rule banned "너도 해봐/도전해봐/써봐" ad-CTAs outright — a self-contradiction that could
  // lead the model straight into the exact ending GENERIC_CTA_ENDING rejects. Only check the
  // "패턴 예시" (recommended pattern) lines, not the ban rule's own quoted counter-examples.
  const exampleLines = guide.split('\n').filter(line => /\[(?:오프닝|마무리) 패턴 예시/.test(line));
  assert.ok(exampleLines.length >= 2, 'expected both opening and closing pattern-example lines');
  for (const line of exampleLines) {
    const quotedExamples = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    for (const example of quotedExamples) {
      assert.deepEqual(policy.voiceProblems(example).filter(r => r === '뻔한 CTA 마무리'), [],
        `voiceGuide() recommended example is a CTA it also bans: "${example}"`);
    }
  }
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

test('high-risk weight-loss claims are caught with 키로/킬로 units, not just kg', () => {
  // Regression: the weight-loss branch only matched the "kg" spelling, so the
  // same claim written with the equally common Korean unit spellings slipped
  // through the safety guard untouched.
  assert.ok(policy.voiceProblems('일주일 만에 3키로 빠짐').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('한 달 만에 5킬로 감량했어').includes('고위험 효능 주장'));
});

test('high-risk cure claims are caught in their natural casual conjugations, not just "낫음"', () => {
  // Regression: "낫다" is ㅅ-irregular - the ㅅ drops before a vowel-starting
  // ending, so the grammatically correct casual forms are 나아/나았/나음/나은
  // (never 낫아/낫음). The old regex only matched the ungrammatical "낫음",
  // so real cured-of-illness claims written the way voiceGuide() itself
  // prefers (짧고 담백한 반말체) never tripped the guard at all.
  assert.ok(policy.voiceProblems('염증이 싹 나았어').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('통증이 다 나음').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('염증이 나아졌음').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('당뇨가 다 나은 느낌').includes('고위험 효능 주장'));
});

test('the unrelated "낫다" comparison sense does not falsely trigger the cure-claim guard', () => {
  // "나아/나은" also mean "better than" in a plain comparison with no illness
  // involved. The cure branch always requires a disease/symptom keyword in
  // the same clause, so ordinary comparisons must stay clear.
  assert.deepEqual(policy.voiceProblems('이 옷이 저 옷보다 나아'), []);
  assert.deepEqual(policy.voiceProblems('나이가 좀 있는 편인데'), []);
  assert.deepEqual(policy.voiceProblems('나아갈 방향을 고민 중'), []);
});

test('absolute claims of protection from real child-safety hazards are caught (choking/swallowing/allergy)', () => {
  // This guard is deliberately narrow, not a blanket "완전/100% 안전" catch - see the next test
  // for why. The real, narrow risk worth code-enforcing is a false claim of protection from
  // actual physical harm to a child, which the parenting-mom persona (threadsPersonas.js)
  // separately warns against in its own prompt text.
  assert.ok(policy.voiceProblems('이 젖병 삼켜도 100% 안전해요').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('이 이유식 알레르기 걱정 전혀 없음').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('질식 위험 없는 사이즈').includes('고위험 효능 주장'));
});

test('a generic "완전/100% 안전" claim does NOT trigger the guard - that is ordinary marketing language', () => {
  // REGRESSION (found live: real posts were failing to publish): an earlier version of this
  // guard matched any "완전 안전"/"100% 안전" regardless of context, which is completely
  // ordinary marketing language across nearly every product category, not a red flag on its
  // own - it was rejecting a huge fraction of ordinary posts across every category, not just
  // kids' products.
  assert.deepEqual(policy.voiceProblems('이 장난감 완전 안전함ㅋㅋ'), []);
  assert.deepEqual(policy.voiceProblems('이 케이스 완전 안전하게 보호해줌'), []);
  assert.deepEqual(policy.voiceProblems('이 콘센트 완전 안전함'), []);
  assert.deepEqual(policy.voiceProblems('헬멧 완전 안전한 느낌'), []);
  assert.deepEqual(policy.voiceProblems('이 잠금장치 100% 안전해요'), []);
  assert.deepEqual(policy.voiceProblems('아이 손 안 닿게 완전 안전하게 설치함'), []);
  assert.deepEqual(policy.voiceProblems('와이파이 완전 안전하게 연결됨'), []);
  assert.deepEqual(policy.voiceProblems('결제 정보 완전 안전하게 보호됨'), []);
  assert.deepEqual(policy.voiceProblems('위험 전혀 없어요'), []);
});

test('the child-safety-hazard guard does not falsely trigger on ordinary "안전"/"완전"/"전혀" phrases', () => {
  assert.deepEqual(policy.voiceProblems('이 정도면 안심되는 편'), []);
  assert.deepEqual(policy.voiceProblems('안전벨트 튼튼함'), []);
  assert.deepEqual(policy.voiceProblems('안전모 착용하고 탐'), []);
  assert.deepEqual(policy.voiceProblems('이거 완전 좋음ㅋㅋ'), []);
  assert.deepEqual(policy.voiceProblems('위험한 느낌은 아닌데'), []);
  assert.deepEqual(policy.voiceProblems('전혀 다른 느낌이었음'), []);
  assert.deepEqual(policy.voiceProblems('완전 신기했음'), []);
  assert.deepEqual(policy.voiceProblems('가격이 완전 착함'), []);
});

test('cure-claim guard also catches 사라지다/가라앉다, not just 낫다/치료되다/없어짐', () => {
  // Regression: 통증/염증 등은 이미 질병·증상 키워드 목록에 있었지만, 완치 동사 목록에는
  // "사라지다"(disappear)와 "가라앉다"(subside)가 아예 없었다. 심지어 이미 목록에 있던
  // "없어짐"도 정확히 그 활용형만 매칭해서 "없어졌어"/"없어져" 같은 흔한 변형은 놓치고 있었다.
  // 일상 반말에서 "낫다"/"치료되다"만큼, 혹은 그보다 더 자주 쓰이는 표현들이라 실제 효능
  // 주장이 완전히 안 걸리고 있었다.
  assert.ok(policy.voiceProblems('통증 100% 사라짐').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('염증이 사라졌어').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('염증이 없어졌어').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('염증이 가라앉았어').includes('고위험 효능 주장'));
  assert.ok(policy.voiceProblems('통증이 가라앉음').includes('고위험 효능 주장'));
});

test('사라지다/가라앉다 do not falsely trigger without a disease/symptom keyword nearby', () => {
  assert.deepEqual(policy.voiceProblems('스트레스가 싹 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('먼지가 다 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('냄새가 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('얼룩이 사라졌어'), []);
});

test('"병" was removed from the disease-keyword list - it is bare-word ambiguous with "bottle"', () => {
  // Regression found live (real posts failing to publish): "병" matches both "disease" and the
  // extremely common "-병" bottle/container suffix (화장품병, 샴푸병, 오일병, 약병, 유리병, or a
  // bare "이 오일 병"). That ambiguity was already a latent false-positive risk with the original
  // "없어짐" alone, but widening the verb list this session to include 사라지다/가라앉다 - both
  // completely ordinary ways to describe a bottle's contents running out or sediment settling -
  // turned it into a routine false rejection for completely normal beauty/food product reviews.
  assert.deepEqual(policy.voiceProblems('이 화장품병 안에 있던 크림이 다 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('유리병에 담긴 오일 금방 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('샴푸병 내용물이 순식간에 없어짐'), []);
  assert.deepEqual(policy.voiceProblems('이 오일병 냄새가 사라짐'), []);
  assert.deepEqual(policy.voiceProblems('약병 안에 먼지가 가라앉았어'), []);
  // 질환 already covers the "disease" sense unambiguously, and every other keyword (암/통증/염증/
  // 당뇨/고혈압) has no equivalent common-word collision, so genuine claims are still caught.
  assert.ok(policy.voiceProblems('이 질환 완치됨').includes('고위험 효능 주장'));
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

test('a health claim the factual audit clears is not rejected outright', async () => {
  // Regression: reviewSourceVoice used to call the audit and then reject
  // unconditionally regardless of its result, making the audit pointless -
  // any text matching the blunt highRiskClaim regex was always rejected
  // even when the model confirmed it was accurate/sourced.
  const text = '한 달 만에 12kg 빠졌어\n진짜 신기함ㅋㅋ';
  const out = await policy.reviewSourceVoice(text, { sourceText: '체중 12kg 감량 인증 게시물' }, async () => {
    return { issues: [], sourceAnchors: ['체중 12kg 감량 인증 게시물'] };
  });
  assert.equal(out, text);
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
