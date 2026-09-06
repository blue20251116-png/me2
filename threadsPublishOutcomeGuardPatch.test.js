'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const originalPost = axios.post;

test('tags failed threads_publish request with creation id', async () => {
  axios.__me2PublishOutcomeGuardInstalled = false;
  axios.post = async () => { const err = new Error('timeout'); err.code = 'ETIMEDOUT'; throw err; };
  delete require.cache[require.resolve('./threadsPublishOutcomeGuardPatch')];
  require('./threadsPublishOutcomeGuardPatch');
  await assert.rejects(
    axios.post('https://graph.threads.net/v1.0/me/threads_publish', null, { params: { creation_id: 'creation-123' } }),
    err => err.creationId === 'creation-123' && err.publishOutcomeUnknown === true
  );
  axios.post = originalPost;
  axios.__me2PublishOutcomeGuardInstalled = false;
});

test('does not tag ordinary Threads create failures', async () => {
  axios.__me2PublishOutcomeGuardInstalled = false;
  axios.post = async () => { const err = new Error('timeout'); err.code = 'ETIMEDOUT'; throw err; };
  delete require.cache[require.resolve('./threadsPublishOutcomeGuardPatch')];
  require('./threadsPublishOutcomeGuardPatch');
  await assert.rejects(
    axios.post('https://graph.threads.net/v1.0/me/threads', null, { params: {} }),
    err => !err.creationId && !err.publishOutcomeUnknown
  );
  axios.post = originalPost;
  axios.__me2PublishOutcomeGuardInstalled = false;
});
