'use strict';
// 2026-10-14 reach fixes for the 7 owner accounts: planning-note leak, Coupang opener template,
// rotating frame A openings, link-free recipe comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-reach-'));

const { db } = require('../src/infra/db');
const policy = require('../src/content/voicePolicy');
const ap = require('../src/content/accountPersonas');
const frames = require('../src/content/postFrames');
const { buildCommentText } = require('../src/publish/commentText');

for (const id of [1, 2, 3, 4, 10, 11, 13, 14])
  db.prepare('INSERT OR IGNORE INTO accounts (id,label) VALUES (?,?)').run(id, `acct${id}`);

// The two posts that went out on 2026-10-14 with the writer's plan as their first line.
const LEAK_6750 =
  '저녁 메뉴 고민으로 간다. 최근 첫 줄(학원 앞 10분, 거실 원상복구)과 겹치지 않게.\n\n장 봐온 게 이틀 치인데\n오늘도 뭐 해먹을지 모르겠음';
const LEAK_6753 =
  '원룸 빨래 말리기로 골랐고, 최근 첫 줄과 겹치지 않게 썼다.\n\n건조대를 침대 옆에 펴놨더니\n퇴근하고 오면 양말이 나를 맞이함';

test('planning leak: the published leaked first lines are detected, stripped and rejected', () => {
  for (const t of [LEAK_6750, LEAK_6753]) {
    assert.equal(policy.planningLeakLines(t).length, 1);
    assert.ok(policy.voiceProblems(t).includes('작성 메모 노출'));
    const clean = policy.stripLeadingPlanningLines(t);
    assert.equal(policy.planningLeakLines(clean).length, 0);
    assert.ok(!policy.voiceProblems(clean).includes('작성 메모 노출'));
  }
  assert.match(policy.stripLeadingPlanningLines(LEAK_6750), /^장 봐온 게 이틀 치인데/);
  // Ordinary lines are not mistaken for planning notes.
  for (const ok of [
    '퇴근하고 회사로 간다고 했는데 결국 집으로 감',
    '첫줄 생각 하나',
    '저녁 메뉴 골랐는데 남편이 또 라면 먹재',
    '가계부는 매일 밤 쓴다',
    '아침 9시에 커피 내리는 소리가 출근 알람 같음',
  ])
    assert.deepEqual(policy.planningLeakLines(ok), [], ok);
});

test('coupang opener: banned for owner accounts only', () => {
  const t = '쿠팡 뒤지다가 발견함ㄷㄷ\n\n세면대 솔이 3100원이라니\n\n두 개 더 담아놨음';
  assert.ok(policy.coupangOpener(t));
  assert.ok(policy.coupangOpener('퇴근하고 쿠팡 구경하다가 결국 질러버림'));
  const owner = policy.voiceProblems(t, { bannedPhrases: ap.bannedPhrasesFor(1) });
  assert.ok(owner.includes('쿠팡 발견 템플릿'));
  assert.ok(!policy.voiceProblems(t).includes('쿠팡 발견 템플릿'), 'customer accounts unchanged');
  assert.ok(!policy.coupangOpener('장 보다가 넣을까 말까 하던 거 결국 삼'));
});

test('frame A: rotating opening hint, never the "쿠팡 뒤지다가" example', () => {
  const seen = new Set();
  for (let i = 0; i < frames.FRAME_A_OPENINGS.length; i++) {
    const block = frames.frameBlock('A', () => i / frames.FRAME_A_OPENINGS.length);
    assert.ok(!block.includes('{{OPENING_HINT}}'));
    assert.ok(block.includes(frames.FRAME_A_OPENINGS[i]));
    assert.ok(!/예\)\s*"쿠팡 뒤지다가/.test(block));
    seen.add(frames.FRAME_A_OPENINGS[i]);
    assert.ok(!policy.coupangOpener(frames.FRAME_A_OPENINGS[i]));
  }
  assert.ok(seen.size >= 5);
  assert.equal(frames.frameBlock('B'), frames.FRAMES.B.block);
});

test('daily story: a leaked plan at the top is stripped, and leaked lines are not fed back as recent openings', async () => {
  const aiClient = require('../src/integrations/aiClient');
  const original = aiClient.callAI;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  ap.setAccountPersonaConfig({ accounts: { 1: 'acct-home-keeper' } });
  db.prepare('DELETE FROM posts').run();
  db.prepare(
    `INSERT INTO posts (account_id,text,scheduled_at,status,content_mode) VALUES (1,?,?,'posted','daily')`
  ).run(LEAK_6750, '2026-10-14T12:38:00.000Z');
  const calls = [];
  aiClient.callAI = async (_key, req) => {
    calls.push(req);
    return [
      '오늘 소재는 빨래 개기로 골랐다.',
      '',
      '빨래 개는 것까지는 하겠는데 넣는 게 제일 귀찮음',
      '거실에 갠 빨래가 이틀째 탑처럼 쌓여 있음',
      '',
      '다들 갠 빨래 바로 넣어?',
    ].join('\n');
  };
  delete require.cache[require.resolve('../src/content/contentOnlyAutomation')];
  try {
    const { generateDailyStory } = require('../src/content/contentOnlyAutomation');
    const r = await generateDailyStory(1, '전체');
    assert.ok(!/골랐다/.test(r.text), r.text);
    assert.match(r.text, /^빨래 개는 것까지는/);
    // The leaked line of post 6750 is skipped; its first real line is used as the recent opening.
    assert.ok(!calls[0].userContent.includes('학원 앞 10분'));
    assert.ok(calls[0].userContent.includes('장 봐온 게 이틀 치인데'));
    // Owner runner path: no Pexels/Pixabay key -> fails fast before any AI call.
    const before = calls.length;
    await assert.rejects(generateDailyStory(1, '전체', { requirePhoto: true }), /사진 소스 없음/);
    assert.equal(calls.length, before);
  } finally {
    aiClient.callAI = original;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    ap.setAccountPersonaConfig(null);
    db.prepare('DELETE FROM posts').run();
    delete require.cache[require.resolve('../src/content/contentOnlyAutomation')];
  }
});

test('comments: a link-free recipe post (-nolink) gets its recipe comment; a missing link elsewhere still stops', async () => {
  const account = { id: 1, coupang_access_key: 'a', coupang_secret_key: 'b' };
  const recipe = '🥘 재료\n- 연근 1개\n- 굴소스 1숟갈\n\n🍳 만드는 법\n1. 볶는다';
  const out = await buildCommentText(account, {
    link: null,
    recipe_comment_text: recipe,
    content_mode: 'recipe-nolink',
  });
  assert.match(out, /굴소스/);
  assert.ok(!/쿠팡 파트너스/.test(out), 'no link, no disclosure needed');
  await assert.rejects(
    buildCommentText(account, { link: null, recipe_comment_text: recipe, content_mode: 'recipe' }),
    /링크가 비어/
  );
  // Linked posts still carry the Coupang Partners disclosure.
  const linked = await buildCommentText(account, {
    link: 'https://link.coupang.com/a/abc',
    recipe_comment_text: recipe,
    content_mode: 'recipe',
  });
  assert.match(linked, /쿠팡 파트너스 활동의 일환/);
});
