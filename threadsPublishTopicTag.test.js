'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the DB account lookup and axios BEFORE threadsApi.js loads (it destructures getAccount).
const dbm = require('./db');
dbm.getAccount = () => ({ id: 1, threads_access_token: 'tok', threads_user_id: 'u1' });
const axios = require('axios');
const api = require('./threadsApi');

function withAxios(post, fn) {
  const orig = axios.post;
  axios.post = post;
  return Promise.resolve().then(fn).finally(() => { axios.post = orig; });
}

test('publishPost attaches a topic_tag picked from the post text', async () => {
  const calls = [];
  await withAxios(async (url, _body, { params }) => {
    calls.push({ url, params: { ...params } });
    return { data: { id: url.endsWith('/threads_publish') ? 'media-1' : 'creation-1' } };
  }, async () => {
    const id = await api.publishPost(1, { text: '애기 이유식 만들 때 이거 씀\n\n다들 몇 개월부터 했어?' });
    assert.equal(id, 'media-1');
  });
  assert.equal(calls[0].params.topic_tag, '육아');
  assert.equal(calls[0].params.media_type, 'TEXT');
});

test('a rejected topic_tag never blocks publishing: the container is re-created without it', async () => {
  const calls = [];
  await withAxios(async (url, _body, { params }) => {
    calls.push({ url, params: { ...params } });
    if (url.endsWith('/me/threads') && params.topic_tag) {
      const err = new Error('Request failed with status code 400');
      err.response = { status: 400, data: { error: { message: 'Invalid parameter: topic_tag' } } };
      throw err;
    }
    return { data: { id: url.endsWith('/threads_publish') ? 'media-2' : 'creation-2' } };
  }, async () => {
    assert.equal(await api.publishPost(1, { text: '설거지 쌓아두는 사람 나만 이래?' }), 'media-2');
  });
  const creates = calls.filter(c => c.url.endsWith('/me/threads'));
  assert.equal(creates.length, 2);
  assert.equal(creates[0].params.topic_tag, '살림');
  assert.equal('topic_tag' in creates[1].params, false);
});

test('posts with no matching topic are sent exactly as before (no topic_tag param)', async () => {
  const calls = [];
  await withAxios(async (url, _body, { params }) => {
    calls.push({ url, params: { ...params } });
    return { data: { id: 'x' } };
  }, () => api.publishPost(1, { text: '아무 관련 없는 문장' }));
  assert.equal('topic_tag' in calls[0].params, false);
});
