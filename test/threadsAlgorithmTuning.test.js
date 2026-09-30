'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/content/voicePolicy');
const { PERSONAS } = require('../src/content/personas');
const { pickTopicTag, sanitizeTopicTag, isTopicTagRejection } = require('../src/threads/topicTag');
const tokens = require('../src/threads/tokenRefresh');
const { isBlockedHost } = require('../src/integrations/scraper');

// 2026-09-30 (user: "스레드 알고리즘 타는 글에 맞춰줘 — 글때문에 조회수가 잘 안 나옴").

test('every persona carries the shared Threads-algorithm section (first line / replies / dwell / reposts / ad + bait penalties)', () => {
  for (const persona of PERSONAS) {
    const guide = policy.voiceGuide(persona.block);
    assert.match(guide, /\[스레드 알고리즘 기준/, `${persona.id} missing algorithm section`);
    assert.match(
      guide,
      /3초 안에 자기 얘기로 답할 수 있어야 한다/,
      `${persona.id} missing easy-to-answer question rule`
    );
    assert.match(guide, /광고 감지\(감점\)/, `${persona.id} missing ad-penalty rule`);
    assert.match(guide, /참여 낚시\(감점\)/, `${persona.id} missing engagement-bait rule`);
  }
});

test('the shared guide no longer suggests tag-bait ("아는 사람 태그 유도") as a closing', () => {
  assert.doesNotMatch(policy.voiceGuide(), /아는 사람 태그 유도 등\)로/);
});

test('voiceProblems flags reader-directed engagement bait', () => {
  for (const bait of [
    '궁금하면 댓글 남겨줘',
    '댓글 달면 링크 보내줌',
    '댓글 남기면 알려줄게',
    '좋아요 눌러줘',
    '팔로우하면 정보 줌',
    '공유 부탁해',
    '친구 태그해',
  ]) {
    assert.ok(policy.voiceProblems(bait).includes('참여 낚시'), `not flagged: ${bait}`);
  }
});

test('engagement-bait guard leaves author announcements and plain questions alone', () => {
  for (const ok of [
    '재료는 댓글에 적어둘게',
    '레시피는 댓글로 남겨둘게',
    '정체는 답글에 적어둠',
    '다들 이럴 때 어떻게 해?',
    '이 옷 좋아요 진짜',
    '부먹파야 찍먹파야?',
  ]) {
    assert.ok(!policy.voiceProblems(ok).includes('참여 낚시'), `false positive: ${ok}`);
  }
  // the unattended recipe path appends one of these teasers to the body
  for (const teaser of require('../src/content/contentOnlyAutomation').RECIPE_COMMENT_TEASERS) {
    assert.deepEqual(policy.voiceProblems(teaser), [], `teaser flagged: ${teaser}`);
  }
});

test('the empathy persona exists for non-recipe categories and ends on easy-to-answer questions', () => {
  const empathy = PERSONAS.find(p => p.id === 'empathy');
  assert.ok(empathy);
  assert.deepEqual(empathy.categories.sort(), ['fitness', 'general', 'kids']);
  const closing = empathy.block.split('\n').find(l => l.includes('[마무리 패턴 예시'));
  const questions = [...closing.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(q => q.endsWith('?'));
  assert.ok(questions.length >= 2);
});

test('every persona offers at least one question among its closing examples', () => {
  for (const persona of PERSONAS) {
    const closing = persona.block.split('\n').find(l => l.includes('[마무리 패턴 예시'));
    const examples = [...closing.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.ok(
      examples.some(e => /\?$/.test(e)),
      `${persona.id} has no question closing: ${examples.join(' / ')}`
    );
  }
});

test('pickTopicTag maps post text to one Threads topic tag, most specific first', () => {
  assert.equal(pickTopicTag('애기 이유식 만들 때 이거 씀'), '육아');
  assert.equal(pickTopicTag('피티쌤이 알려준 스쿼트 자세'), '운동');
  assert.equal(pickTopicTag('간장 2큰술 넣고 볶음'), '요리');
  assert.equal(pickTopicTag('설거지 쌓아두는 사람 나야 나'), '살림');
  assert.equal(pickTopicTag('선크림 바르면 하얗게 뜨는 사람'), '뷰티');
  assert.equal(pickTopicTag('아무 관련 없는 문장'), null);
  assert.equal(pickTopicTag(''), null);
});

test('topic tags are sanitized to Threads rules and a rejected tag is detectable for retry', () => {
  assert.equal(sanitizeTopicTag('#A&B.C'), 'ABC');
  assert.equal(sanitizeTopicTag('x'.repeat(80)).length, 50);
  assert.ok(
    isTopicTagRejection({ response: { status: 400, data: { error: { message: 'Invalid parameter topic_tag' } } } })
  );
  assert.ok(!isTopicTagRejection({ response: { status: 400, data: { error: { message: 'Invalid image' } } } }));
  assert.ok(!isTopicTagRejection({ response: { status: 500, data: { error: { message: 'topic' } } } }));
});

test('autopilot slots stay inside the 07:00-24:00 KST active window', () => {
  const { plannedSlots } = require('../src/publish/scheduler');
  for (const target of [1, 15, 25]) {
    for (const accountId of [1, 2, 7, 42]) {
      const slots = plannedSlots('2026-10-01', target, accountId);
      assert.equal(slots.length, target);
      for (const d of slots) {
        const kstHour = (d.getUTCHours() + 9) % 24;
        assert.ok(kstHour >= 7, `slot at ${kstHour}:xx KST is outside the active window`);
        assert.equal(new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10), '2026-10-01');
      }
      assert.equal(new Set(slots.map(d => d.toISOString().slice(0, 16))).size, target, 'no duplicate minutes');
    }
  }
});

test('token expiry accepts both the legacy ms-epoch string and ISO', () => {
  const ms = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(tokens.parseTokenExpiry(String(ms)), ms);
  assert.equal(tokens.parseTokenExpiry('2026-11-01T00:00:00.000Z'), ms);
  assert.equal(tokens.parseTokenExpiry(''), null);
  assert.ok(tokens.isTokenExpired({ threads_token_expires_at: String(Date.now() - 1000) }));
  assert.ok(!tokens.isTokenExpired({ threads_token_expires_at: String(Date.now() + 86400000) }));
  assert.ok(!tokens.isTokenExpired({}));
});

test('needsRefresh only refreshes live tokens that are >=24h old and near expiry', () => {
  const now = Date.parse('2026-10-01T00:00:00Z'),
    day = 86400000;
  const acct = exp => ({ threads_access_token: 't', threads_token_expires_at: new Date(exp).toISOString() });
  assert.ok(tokens.needsRefresh(acct(now + 5 * day), now));
  assert.ok(!tokens.needsRefresh(acct(now + 30 * day), now));
  assert.ok(!tokens.needsRefresh(acct(now - day), now), 'expired tokens need a reconnect, not a refresh');
  assert.ok(!tokens.needsRefresh({ threads_access_token: '' }, now));
});

test('refreshDueTokens stores the refreshed token with an ISO expiry and survives per-account failures', async () => {
  const now = Date.parse('2026-10-01T00:00:00Z'),
    day = 86400000;
  const rows = {
    1: { id: 1, threads_access_token: 'old1', threads_token_expires_at: String(now + 3 * day) },
    2: { id: 2, threads_access_token: 'old2', threads_token_expires_at: String(now + 3 * day) },
    3: { id: 3, threads_access_token: 'old3', threads_token_expires_at: String(now + 40 * day) },
  };
  const updates = [];
  const store = {
    listAllAccountsForSystem: () => Object.values(rows).map(r => ({ id: r.id })),
    getAccount: id => rows[id],
    updateAccount: (id, f) => updates.push([id, f]),
  };
  const refresh = async t => {
    if (t === 'old2') throw new Error('boom');
    return { access_token: `new-${t}`, expires_in: 5184000 };
  };
  const result = await tokens.refreshDueTokens({ refresh, now, store });
  assert.deepEqual(result, { refreshed: 1, failed: 1 });
  assert.deepEqual(updates, [
    [1, { threads_access_token: 'new-old1', threads_token_expires_at: new Date(now + 5184000 * 1000).toISOString() }],
  ]);
});

test('product scraper refuses internal/metadata hosts but allows public shops', () => {
  for (const h of [
    '169.254.169.254',
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.10',
    '172.16.5.5',
    'db.railway.internal',
    '[::1]',
  ])
    assert.ok(isBlockedHost(h), h);
  for (const h of ['link.coupang.com', 'www.coupang.com', 'smartstore.naver.com', 'fcbarcelona.com'])
    assert.ok(!isBlockedHost(h), h);
});
