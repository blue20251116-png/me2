'use strict';
// 2026-11-05 review: the publish queue puts the Coupang Partners line at the end of the BODY of Coupang-link
// posts (the comment keeps its own disclosure), and reads posted auto-comments back to fill
// comment_verified_at. Real SQLite in a temp dir, Threads API stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-publish-1105-'));
process.env.ME2_SECRET_KEY = 'publish-queue-1105-test-key';

require.cache[require.resolve('node-cron')] = {
  exports: { schedule: () => ({ stop() {} }), getTasks: () => new Map() },
};
const calls = [];
let verify = async () => ({ verified: true, permalink: 'https://www.threads.net/@a/post/R', reason: '' });
require.cache[require.resolve('../src/threads/threadsApi')] = {
  exports: {
    publishPost: async (accountId, opts) => {
      calls.push({ fn: 'publishPost', opts });
      return 'media-1';
    },
    publishCarouselPost: async (accountId, opts) => {
      calls.push({ fn: 'publishCarouselPost', opts });
      return 'carousel-1';
    },
    publishReply: async (accountId, mediaId, text) => {
      calls.push({ fn: 'publishReply', mediaId, text });
      return 'reply-1';
    },
    verifyReply: async (...args) => {
      calls.push({ fn: 'verifyReply', args });
      return verify(...args);
    },
  },
};

const { db, createAccount, updateAccount, createUser, approveUser } = require('../src/infra/db');
const { startPublishJob, verifyPostedComments } = require('../src/publish/publishQueue');
const { buildCommentText } = require('../src/publish/commentText');

createUser('owner1105@example.com', 'x:y', 'o||THREADS:owner_t');
const userId = db.prepare("SELECT id FROM users WHERE email='owner1105@example.com'").get().id;
approveUser(userId, null, 30);
const acc = Number(createAccount('acc', userId));
updateAccount(acc, { threads_access_token: 'token-1' });

const past = (ms = 60000) => new Date(Date.now() - ms).toISOString();
function addPost(fields) {
  const row = { account_id: acc, text: 'hello', scheduled_at: past(), auto_comment_enabled: 0, ...fields };
  const keys = Object.keys(row);
  return Number(
    db.prepare(`INSERT INTO posts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row))
      .lastInsertRowid
  );
}
const post = id => db.prepare('SELECT * FROM posts WHERE id=?').get(id);
const tick = startPublishJob({ buildCommentText });

test.beforeEach(() => {
  calls.length = 0;
  db.prepare("UPDATE posts SET status='done' WHERE status IN ('pending','publishing')").run();
  db.prepare("UPDATE posts SET comment_status='done' WHERE comment_status IN ('pending','posted')").run();
});

test('a Coupang-link post is published with the disclosure as its last body line; the stored text is unchanged', async () => {
  const body = '퇴근하고 바닥에 누움\n\n폭신해서 그대로 잠듦';
  const id = addPost({ text: body, link: 'https://link.coupang.com/a/abc', image_url: 'https://cdn.example/a.jpg' });
  await tick();
  const sent = calls.find(c => c.fn === 'publishPost').opts.text;
  assert.equal(sent, `${body}\n\n쿠팡 파트너스 활동으로 수수료를 받을 수 있음`);
  assert.equal(post(id).text, body);
  assert.equal(post(id).status, 'posted');
});

test('a post without a Coupang link is published as written', async () => {
  addPost({ text: '그냥 일상 글', image_url: 'https://cdn.example/b.jpg' });
  await tick();
  assert.equal(calls.find(c => c.fn === 'publishPost').opts.text, '그냥 일상 글');
});

test('the comment keeps its own full disclosure', async () => {
  const comment = await buildCommentText({}, { link: 'https://link.coupang.com/a/abc', recipe_comment_text: '한 줄', content_mode: 'product' });
  assert.match(comment, /\[광고\] 이 포스팅은 쿠팡 파트너스 활동의 일환으로/);
});

test('a posted comment is read back and comment_verified_at is filled', async () => {
  const id = addPost({
    status: 'posted',
    threads_media_id: 'p1',
    comment_status: 'posted',
    comment_media_id: 'c1',
    comment_posted_at: past(5 * 60000),
  });
  await verifyPostedComments();
  assert.ok(post(id).comment_verified_at);
  assert.deepEqual(calls.find(c => c.fn === 'verifyReply').args, [acc, 'c1', 'p1']);
  calls.length = 0;
  await verifyPostedComments();
  assert.equal(calls.filter(c => c.fn === 'verifyReply' && c.args[1] === 'c1').length, 0, 'verified once only');
});

test('a missing comment is recorded once and never re-posted; transient errors retry; fresh comments wait', async () => {
  const missing = addPost({ status: 'posted', threads_media_id: 'p2', comment_status: 'posted', comment_media_id: 'c2', comment_posted_at: past(5 * 60000) });
  verify = async () => ({ verified: false, permalink: '', reason: 'COMMENT_NOT_FOUND' });
  await verifyPostedComments();
  assert.equal(post(missing).comment_verified_at, null);
  assert.equal(post(missing).comment_error_message, 'COMMENT_VERIFY_FAILED: COMMENT_NOT_FOUND');
  assert.equal(post(missing).comment_status, 'posted');
  assert.equal(calls.filter(c => c.fn === 'publishReply').length, 0);

  const flaky = addPost({ status: 'posted', threads_media_id: 'p3', comment_status: 'posted', comment_media_id: 'c3', comment_posted_at: past(5 * 60000) });
  verify = async () => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  };
  await verifyPostedComments();
  assert.equal(post(flaky).comment_error_message, null);
  verify = async () => ({ verified: true, permalink: '', reason: '' });
  await verifyPostedComments();
  assert.ok(post(flaky).comment_verified_at);

  const fresh = addPost({ status: 'posted', threads_media_id: 'p4', comment_status: 'posted', comment_media_id: 'c4', comment_posted_at: new Date().toISOString() });
  await verifyPostedComments();
  assert.equal(post(fresh).comment_verified_at, null);
});
