'use strict';
// 2026-11-05 (marketing c1266546): posts lost mid-publish are resolved with read-only checks (live ->
// posted, not live -> one re-queue, never a double post), ERR_CANCELED gets one retry, the sent body and
// the body-disclosure flag are stored, and a drain stops the queue. Temp SQLite, fake Threads API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-recover-1105-'));
process.env.ME2_SECRET_KEY = 'publish-recover-1105-test-key';

require.cache[require.resolve('node-cron')] = {
  exports: { schedule: () => ({ stop() {} }), getTasks: () => new Map() },
};
const calls = [];
const fake = { recent: [], containers: {}, publish: null, recentError: null };
require.cache[require.resolve('../src/threads/threadsApi')] = {
  exports: {
    publishPost: async (accountId, opts) => {
      calls.push({ fn: 'publishPost', opts });
      return fake.publish ? fake.publish(opts) : 'media-new';
    },
    publishCarouselPost: async (accountId, opts) => {
      calls.push({ fn: 'publishCarouselPost', opts });
      return 'carousel-new';
    },
    publishReply: async () => {
      calls.push({ fn: 'publishReply' });
      return 'reply-1';
    },
    listRecentThreads: async accountId => {
      calls.push({ fn: 'listRecentThreads', accountId });
      if (fake.recentError) throw fake.recentError;
      return fake.recent;
    },
    getAccountContainerStatus: async (accountId, creationId) => {
      calls.push({ fn: 'getAccountContainerStatus', creationId });
      const status = fake.containers[creationId];
      if (status instanceof Error) throw status;
      return { id: creationId, status: status || 'FINISHED' };
    },
  },
};

const { db, createAccount, updateAccount, createUser, approveUser } = require('../src/infra/db');
const queue = require('../src/publish/publishQueue');
const { matchLivePost } = require('../src/publish/publishRecovery');
const { classifyPublishFailure } = require('../src/publish/publishRetryPolicy');

createUser('recover1105@example.com', 'x:y', 'o||THREADS:owner_t');
const userId = db.prepare("SELECT id FROM users WHERE email='recover1105@example.com'").get().id;
approveUser(userId, null, 30);
const acc = Number(createAccount('acc', userId));
updateAccount(acc, { threads_access_token: 'token-1' });

const ago = ms => new Date(Date.now() - ms).toISOString();
const threadsTime = ms => ago(ms).replace(/\.\d+Z$/, '+0000');
function addPost(fields) {
  const row = { account_id: acc, text: 'hello', scheduled_at: ago(60000), auto_comment_enabled: 0, ...fields };
  const keys = Object.keys(row);
  return Number(
    db.prepare(`INSERT INTO posts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row))
      .lastInsertRowid
  );
}
const post = id => db.prepare('SELECT * FROM posts WHERE id=?').get(id);
const tick = queue.startPublishJob({ buildCommentText: async () => 'comment' });
const publishes = () => calls.filter(c => c.fn === 'publishPost' || c.fn === 'publishCarouselPost').length;
const dueNow = id => db.prepare('UPDATE posts SET publish_next_retry_at=? WHERE id=?').run(ago(1000), id);

test.beforeEach(() => {
  calls.length = 0;
  Object.assign(fake, { recent: [], containers: {}, publish: null, recentError: null });
  db.prepare("UPDATE posts SET status='done' WHERE status IN ('pending','publishing','failed')").run();
});

test('restart mid-publish, not live: re-queued once, published once, never a third time', async () => {
  const id = addPost({ text: '퇴근길에 산 붕어빵 아직 따뜻함', status: 'publishing', publish_started_at: ago(30000) });
  queue.initializeRecovery();
  assert.match(post(id).error_message, /^PUBLISH_OUTCOME_UNKNOWN/);
  await tick();
  assert.equal(publishes(), 0, 'nothing is sent in the recovery tick');
  assert.equal(post(id).status, 'pending');
  assert.match(post(id).error_message, /^REQUEUED_NOT_LIVE/);
  assert.ok(post(id).publish_recovered_at);
  dueNow(id);
  await tick();
  assert.equal(publishes(), 1);
  assert.equal(post(id).status, 'posted');
  assert.equal(post(id).threads_media_id, 'media-new');

  // A second loss of the same post is never re-queued again.
  const again = addPost({
    text: '두 번째 글',
    status: 'publishing',
    publish_started_at: ago(30000),
    publish_recovered_at: ago(60000),
  });
  queue.initializeRecovery();
  calls.length = 0;
  await tick();
  await tick();
  assert.equal(post(again).status, 'failed');
  assert.equal(publishes(), 0);
});

test('outcome unknown but live: marked posted with id and permalink, comment queued, nothing re-sent', async () => {
  const text = '베란다 화분에 새싹 올라옴\n\n물 주는 거 까먹을까봐 알람 맞춤';
  const id = addPost({
    text,
    link: 'https://link.coupang.com/a/xyz',
    auto_comment_enabled: 1,
    status: 'failed',
    error_message: 'PUBLISH_OUTCOME_UNKNOWN: 외부 컨테이너 생성 후 결과 확인 필요',
    publish_started_at: ago(120000),
    publish_creation_id: 'c-1',
  });
  fake.containers['c-1'] = 'PUBLISHED';
  fake.recent = [
    { id: 'older', text, timestamp: threadsTime(3 * 3600000) },
    {
      id: 'm-live',
      text: `${text}\n\n쿠팡 파트너스 활동으로 수수료를 받을 수 있음`,
      timestamp: threadsTime(60000),
      permalink: 'https://www.threads.net/@acc/post/LIVE',
    },
  ];
  await tick();
  const row = post(id);
  assert.equal(row.status, 'posted');
  assert.equal(row.threads_media_id, 'm-live');
  assert.equal(row.threads_permalink, 'https://www.threads.net/@acc/post/LIVE');
  assert.equal(row.error_message, null);
  assert.equal(row.comment_status, 'pending');
  assert.equal(publishes(), 0);
  assert.ok(db.prepare('SELECT 1 FROM insights WHERE post_id=?').get(id));
});

test('container published but post not found: left for a human, never re-sent', async () => {
  const id = addPost({
    text: '못 찾는 글',
    status: 'failed',
    error_message: 'PUBLISH_OUTCOME_UNKNOWN: 외부 컨테이너 생성 후 결과 확인 필요',
    publish_started_at: ago(120000),
    publish_creation_id: 'c-2',
  });
  fake.containers['c-2'] = 'PUBLISHED';
  await tick();
  await tick();
  assert.equal(post(id).status, 'failed');
  assert.match(post(id).error_message, /^PUBLISH_OUTCOME_UNKNOWN_REVIEW/);
  assert.equal(publishes(), 0);
});

test('a transient lookup error defers (no change); an old slot is only marked not live', async () => {
  const id = addPost({
    text: '조회 실패 글',
    status: 'failed',
    error_message: 'PUBLISH_OUTCOME_UNKNOWN: x',
    publish_started_at: ago(60000),
  });
  fake.recentError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  await tick();
  assert.equal(post(id).publish_recovered_at, null);
  assert.equal(post(id).error_message, 'PUBLISH_OUTCOME_UNKNOWN: x');
  fake.recentError = null;
  db.prepare('UPDATE posts SET scheduled_at=? WHERE id=?').run(ago(20 * 3600000), id);
  await tick();
  assert.equal(post(id).status, 'failed');
  assert.match(post(id).error_message, /^PUBLISH_NOT_LIVE/);
  assert.equal(publishes(), 0);
});

test('ERR_CANCELED: one automatic retry, then failed and not re-queued by recovery', async () => {
  const canceled = () => {
    throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
  };
  assert.equal(classifyPublishFailure({ code: 'ERR_CANCELED' }, 0).retry, true);
  assert.equal(classifyPublishFailure({ code: 'ERR_CANCELED' }, 1).retry, false);
  assert.equal(classifyPublishFailure({ code: 'ERR_CANCELED', creationId: 'c' }, 0).outcomeUnknown, true);

  const id = addPost({ text: '영상 글', video_url: 'https://cdn.example/v.mp4' });
  fake.publish = canceled;
  await tick();
  assert.equal(post(id).status, 'pending');
  assert.equal(post(id).publish_retry_count, 1);
  dueNow(id);
  await tick();
  assert.equal(post(id).status, 'failed');
  assert.equal(post(id).error_message, 'ERR_CANCELED');
  calls.length = 0;
  await tick();
  assert.equal(post(id).status, 'failed');
  assert.equal(publishes(), 0);

  // A legacy row (#8798 shape: failed on its first attempt before this fix) is checked and re-queued.
  const legacy = addPost({
    text: '예전 취소 글',
    status: 'failed',
    error_message: 'ERR_CANCELED',
    publish_retry_count: 1,
    publish_started_at: ago(60000),
  });
  fake.publish = null;
  await tick();
  assert.equal(post(legacy).status, 'pending');
  dueNow(legacy);
  await tick();
  assert.equal(post(legacy).status, 'posted');
});

test('a retry whose earlier container is already PUBLISHED is not re-sent, then recovery finds it', async () => {
  const id = addPost({ text: '재시도 전에 확인하는 글', publish_retry_count: 1, publish_creation_id: 'old-c' });
  fake.containers['old-c'] = 'PUBLISHED';
  fake.recent = [{ id: 'm-old', text: '재시도 전에 확인하는 글', timestamp: threadsTime(30000) }];
  await tick();
  assert.equal(publishes(), 0);
  assert.equal(post(id).status, 'posted');
  assert.equal(post(id).threads_media_id, 'm-old');
});

test('the sent body and the body-disclosure flag are stored', async () => {
  const coupang = addPost({
    text: '바닥에 누움',
    link: 'https://link.coupang.com/a/abc',
    image_url: 'https://cdn.example/a.jpg',
  });
  const plain = addPost({ text: '그냥 일상 글', image_url: 'https://cdn.example/b.jpg' });
  await tick();
  assert.equal(post(coupang).sent_text, '바닥에 누움\n\n쿠팡 파트너스 활동으로 수수료를 받을 수 있음');
  assert.equal(post(coupang).disclosure_in_body, 1);
  assert.equal(post(coupang).text, '바닥에 누움');
  assert.equal(post(plain).sent_text, '그냥 일상 글');
  assert.equal(post(plain).disclosure_in_body, 0);
  const sent = calls.filter(c => c.fn === 'publishPost').map(c => c.opts.text);
  assert.deepEqual(sent, [post(coupang).sent_text, post(plain).sent_text]);
});

test('matchLivePost ignores posts older than the attempt and ids already owned by another post', () => {
  const since = Date.now() - 60000;
  const text = '같은 글 내용입니다 열 글자 넘게';
  const items = [
    { id: 'taken', text, timestamp: new Date().toISOString() },
    { id: 'old', text, timestamp: new Date(since - 10 * 60000).toISOString() },
  ];
  assert.equal(matchLivePost(items, { text, since, excludeIds: new Set(['taken']) }), null);
  assert.equal(matchLivePost(items, { text, since }).id, 'taken');
  assert.equal(matchLivePost(items, { text: '다른 글', since }), null);
});

test('after a drain request no new tick claims a post', async () => {
  const id = addPost({ text: '드레인 뒤 글' });
  queue.requestDrain();
  await tick();
  assert.equal(post(id).status, 'pending');
  assert.equal(publishes(), 0);
});
