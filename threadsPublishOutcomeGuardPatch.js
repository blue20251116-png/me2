'use strict';

// Attach the final Threads creation_id to errors from /threads_publish.
// publishQueue uses this marker to fail closed instead of creating a duplicate post.
const axios = require('axios');

if (!axios.__me2PublishOutcomeGuardInstalled) {
  axios.__me2PublishOutcomeGuardInstalled = true;
  const originalPost = axios.post.bind(axios);
  axios.post = async function me2PublishOutcomeGuard(url, data, config) {
    try {
      return await originalPost(url, data, config);
    } catch (err) {
      const target = String(url || '');
      const creationId = config?.params?.creation_id;
      if (/\/me\/threads_publish(?:\?|$)/.test(target) && creationId) {
        err.creationId = String(creationId);
        err.publishOutcomeUnknown = true;
      }
      throw err;
    }
  };
}
