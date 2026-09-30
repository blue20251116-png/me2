'use strict';
// The publish queue against a real SQLite DB with the Threads API stubbed: success bookkeeping,
// missing tokens, retry scheduling, unknown outcomes after container creation, carousels,
// auto-comments and restart recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-publish-'));
process.env.ME2_SECRET_KEY = 'publish-queue-test-key';

// No real cron timers in tests: the tick function is driven directly.
require.cache[require.resolve('node-cron')] = {
  exports: { schedule: () => ({ stop() {} }), getTasks: () => new Map() },
};
const calls = [];
let behaviour = {};
require.cache[require.resolve('../src/threads/threadsApi')] = {
  exports: {
    publishPost: async (accountId, opts) => {
      calls.push({ fn: 'publishPost', accountId, opts });
      return behaviour.publishPost ? behaviour.publishPost(opts) : 'media-1';
    },
    publishCarouselPost: async (accountId, opts) => {
      calls.push({ fn: 'publishCarouselPost', accountId, opts });
      return 'carousel-1';
    },
    publishReply: async (accountId, mediaId, text, opts) => {
      calls.push({ fn: 'publishReply', accountId, mediaId, text, opts });
      return 'reply-1';
    },
  },
};

const { db, createAccount, updateAccount, createUser, approveUser } = require('../src/infra/db');
const { startPublishJob, isPublishing } = require('../src/publish/publishQueue');

createUser('owner@example.com', 'x:y', 'o||THREADS:owner_t');
const userId = db.prepare("SELECT id FROM users WHERE email='owner@example.com'").get().id;
approveUser(userId, null, 30);
const withToken = Number(createAccount('with token', userId));
updateAccount(withToken, { threads_access_token: 'token-1' });
const noToken = Number(createAccount('no token', userId));

const past = () => new Date(Date.now() - 60000).toISOString();
function addPost(fields) {
  const row = { account_id: withToken, text: 'hello', scheduled_at: past(), auto_comment_enabled: 0, ...fields };
  const keys = Object.keys(row);
  return Number(
    db
      .prepare(`INSERT INTO posts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row)).lastInsertRowid
  );
}
const post = id => db.prepare('SELECT * FROM posts WHERE id=?').get(id);
const tick = startPublishJob({ buildCommentText: async (account, p) => `link: ${p.link}` });

test.beforeEach(() => {
  calls.length = 0;
  behaviour = {};
  db.prepare("UPDATE posts SET status='done' WHERE status IN ('pending','publishing')").run();
});

test('a due post is published and fully booked: status, media id, usage and an insights row', async () => {
  const id = addPost({ image_url: 'https://cdn.example/a.jpg' });
  let busyDuringPublish = null;
  behaviour.publishPost = opts => {
    busyDuringPublish = isPublishing();
    opts.onCreated('creation-9');
    return 'media-42';
  };
  await tick();
  const row = post(id);
  assert.equal(row.status, 'posted');
  assert.equal(row.threads_media_id, 'media-42');
  assert.equal(row.publish_creation_id, 'creation-9');
  assert.equal(row.comment_status, 'none');
  assert.equal(busyDuringPublish, true);
  assert.equal(isPublishing(), false);
  assert.ok(db.prepare('SELECT 1 FROM insights WHERE post_id=?').get(id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events WHERE user_id=? AND type='publish'").get(userId).n, 1);
  assert.equal(calls[0].opts.imageUrl, 'https://cdn.example/a.jpg');
});

test('future posts are left alone', async () => {
  const id = addPost({ scheduled_at: new Date(Date.now() + 3600000).toISOString() });
  await tick();
  assert.equal(post(id).status, 'pending');
  assert.equal(calls.length, 0);
});

test('an account without a Threads token fails the post without calling the API', async () => {
  const id = addPost({ account_id: noToken });
  await tick();
  assert.equal(post(id).status, 'failed');
  assert.equal(post(id).error_message, 'THREADS_TOKEN_MISSING');
  assert.equal(calls.length, 0);
});

test('a transient network error before any container exists is retried later', async () => {
  const id = addPost({});
  behaviour.publishPost = () => {
    throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  };
  await tick();
  const row = post(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.publish_retry_count, 1);
  assert.ok(new Date(row.publish_next_retry_at) > new Date());
  // Not due yet, so the next tick does not hammer the API.
  calls.length = 0;
  await tick();
  assert.equal(calls.length, 0);
});

test('a failure after the container was created is never retried blindly (no duplicate posts)', async () => {
  const id = addPost({});
  behaviour.publishPost = opts => {
    opts.onCreated('creation-1');
    // threadsApi tags errors from the publish call itself this way.
    throw Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
      creationId: 'creation-1',
      publishOutcomeUnknown: true,
    });
  };
  await tick();
  const row = post(id);
  assert.equal(row.status, 'failed');
  assert.match(row.error_message, /PUBLISH_OUTCOME_UNKNOWN/);
});

test('a transient error while the container was only being prepared is still retried', async () => {
  const id = addPost({});
  behaviour.publishPost = opts => {
    opts.onCreated('creation-2');
    throw Object.assign(new Error('status poll 503'), { response: { status: 503 } });
  };
  await tick();
  assert.equal(post(id).status, 'pending');
  assert.equal(post(id).publish_creation_id, 'creation-2');
});

test('two images become a carousel; a video post goes through publishPost with the video', async () => {
  const carousel = addPost({ image_url: 'https://a/1.jpg', extra_image_url: 'https://a/2.jpg' });
  const video = addPost({ video_url: 'https://a/v.mp4' });
  await tick();
  assert.equal(post(carousel).threads_media_id, 'carousel-1');
  assert.deepEqual(calls.find(c => c.fn === 'publishCarouselPost').opts.imageUrls, [
    'https://a/1.jpg',
    'https://a/2.jpg',
  ]);
  assert.equal(calls.find(c => c.fn === 'publishPost').opts.videoUrl, 'https://a/v.mp4');
  assert.equal(post(video).status, 'posted');
});

test('auto-comment is queued after publishing and posted as a reply once due', async () => {
  const id = addPost({ auto_comment_enabled: 1, link: 'https://link.coupang.com/x' });
  await tick();
  assert.equal(post(id).comment_status, 'pending');
  db.prepare('UPDATE posts SET comment_next_retry_at=? WHERE id=?').run(past(), id);
  await tick();
  const reply = calls.find(c => c.fn === 'publishReply');
  assert.equal(reply.mediaId, 'media-1');
  assert.equal(reply.text, 'link: https://link.coupang.com/x');
  assert.equal(post(id).comment_status, 'posted');
  assert.equal(post(id).comment_media_id, 'reply-1');
});

test('restart recovery marks posts that were mid-publish as needing review instead of re-posting', async () => {
  const id = addPost({});
  db.prepare("UPDATE posts SET status='publishing' WHERE id=?").run(id);
  require('../src/publish/publishQueue').initializeRecovery();
  assert.equal(post(id).status, 'failed');
  assert.match(post(id).error_message, /PUBLISH_OUTCOME_UNKNOWN/);
});
