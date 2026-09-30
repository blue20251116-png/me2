'use strict';
// threadsApi publishing against a stubbed Graph API: container → (wait) → publish, the creation
// callback, fail-closed tagging of ambiguous publish errors, media processing failures and the
// reply resume path.
const test = require('node:test');
const assert = require('node:assert/strict');

const dbm = require('../src/infra/db');
dbm.getAccount = () => ({ id: 1, threads_access_token: 'tok', threads_user_id: 'u1' });
require.cache[require.resolve('../src/threads/imageCache')] = { exports: { cacheImage: async url => url } };
const axios = require('axios');
const api = require('../src/threads/threadsApi');

async function withGraph({ post, get }, fn) {
  const orig = { post: axios.post, get: axios.get };
  axios.post = post || orig.post;
  axios.get = get || orig.get;
  try {
    return await fn();
  } finally {
    Object.assign(axios, orig);
  }
}
const httpError = (status, message = 'fail') =>
  Object.assign(new Error(message), { response: { status, data: { error: { message } } } });

test('an image post waits for the container, reports the creation id, then publishes', async () => {
  const created = [];
  const posts = [];
  const id = await withGraph(
    {
      post: async (url, _b, { params }) => {
        posts.push({ url, params: { ...params } });
        return { data: { id: url.endsWith('/threads_publish') ? 'media-7' : 'creation-7' } };
      },
      get: async () => ({ data: { id: 'creation-7', status: 'FINISHED' } }),
    },
    () =>
      api.publishPost(1, { text: '오늘 산 것', imageUrl: 'https://cdn.example/x.jpg', onCreated: c => created.push(c) })
  );
  assert.equal(id, 'media-7');
  assert.deepEqual(created, ['creation-7']);
  assert.equal(posts[0].params.media_type, 'IMAGE');
  assert.equal(posts[0].params.image_url, 'https://cdn.example/x.jpg');
  assert.equal(posts[1].params.creation_id, 'creation-7');
});

test('a failed publish call is tagged as an unknown outcome so the queue never re-posts it', async () => {
  const err = await withGraph(
    {
      post: async url => {
        if (url.endsWith('/threads_publish')) throw httpError(400, 'Invalid request');
        return { data: { id: 'creation-8' } };
      },
    },
    () => api.publishPost(1, { text: '텍스트 글' }).catch(e => e)
  );
  assert.equal(err.creationId, 'creation-8');
  assert.equal(err.publishOutcomeUnknown, true);
});

test('a container that Threads marks ERROR fails as a media processing error', async () => {
  const err = await withGraph(
    {
      post: async () => ({ data: { id: 'creation-9' } }),
      get: async () => ({ data: { id: 'creation-9', status: 'ERROR', error_message: 'bad image' } }),
    },
    () => api.publishPost(1, { text: 'x', imageUrl: 'https://cdn.example/bad.jpg' }).catch(e => e)
  );
  assert.equal(err.code, 'THREADS_MEDIA_PROCESSING_FAILED');
  assert.match(err.message, /bad image/);
  assert.equal(err.creationId, 'creation-9');
});

test('a reply resumed from a stored creation id that is already published is not posted twice', async () => {
  let published = false;
  const err = await withGraph(
    {
      post: async () => {
        published = true;
        return { data: { id: 'x' } };
      },
      get: async () => ({ data: { id: 'c-1', status: 'PUBLISHED' } }),
    },
    () => api.publishReply(1, 'parent-1', '댓글', { creationId: 'c-1' }).catch(e => e)
  );
  assert.equal(err.code, 'COMMENT_OUTCOME_UNKNOWN');
  assert.equal(published, false);
});

test('a reply resumed from an unpublished container publishes that container', async () => {
  const posts = [];
  const id = await withGraph(
    {
      post: async (url, _b, { params }) => {
        posts.push({ url, params });
        return { data: { id: 'reply-media' } };
      },
      get: async () => ({ data: { id: 'c-2', status: 'FINISHED' } }),
    },
    () => api.publishReply(1, 'parent-1', '댓글', { creationId: 'c-2' })
  );
  assert.equal(id, 'reply-media');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].params.creation_id, 'c-2');
});
