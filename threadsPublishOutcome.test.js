'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { publishContainer } = require('./threadsApi');

// publishQueue uses err.creationId/publishOutcomeUnknown to fail closed instead of creating a
// duplicate post when /threads_publish errors after Threads may have already accepted it. This
// used to be a global axios.post wrapper (threadsPublishOutcomeGuardPatch.js); it's now tagged
// directly at threadsApi.js's one actual /threads_publish call site inside publishContainer().

test('tags a failed threads_publish call with creation id', async () => {
  const originalPost = axios.post;
  axios.post = async () => { const err = new Error('timeout'); err.code = 'ETIMEDOUT'; throw err; };
  try {
    await assert.rejects(
      publishContainer('creation-123', 'token', 1, 0),
      err => err.creationId === 'creation-123' && err.publishOutcomeUnknown === true
    );
  } finally {
    axios.post = originalPost;
  }
});
