'use strict';
// Shared Threads Graph API plumbing: base URL, per-account app credentials, error logging and
// error classification used by auth and publishing.
const { getSystemApiSettings } = require('../infra/db');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function resolveThreadsAppCreds(account) {
  const shared = getSystemApiSettings();
  return {
    appId: shared.threads_app_id || process.env.THREADS_APP_ID || account?.threads_app_id || null,
    appSecret: shared.threads_app_secret || process.env.THREADS_APP_SECRET || account?.threads_app_secret || null,
    redirectUri:
      shared.threads_redirect_uri || process.env.THREADS_REDIRECT_URI || account?.threads_redirect_uri || null,
  };
}

function logThreadsError(stage, err, extra = {}) {
  const apiErr = err.response?.data?.error || {},
    status = err.response?.status || '-';
  console.error(
    `[Threads][${stage}][ERROR] status=${status} type=${apiErr.type || '-'} code=${apiErr.code || '-'} subcode=${apiErr.error_subcode || '-'} message=${apiErr.message || err.message || '-'} ` +
      Object.entries(extra)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
  );
  console.error(`[Threads][${stage}][RAW]`, JSON.stringify(err.response?.data || {}));
}

function isRetryablePublishError(err) {
  const apiErr = err.response?.data?.error || {},
    message = String(apiErr.message || err.message || '').toLowerCase();
  return (
    err.response?.status === 404 ||
    apiErr.code === 24 ||
    message.includes('requested resource does not exist') ||
    message.includes('media not found') ||
    message.includes('not ready') ||
    message.includes('still processing') ||
    message.includes('processing') ||
    message.includes('please wait') ||
    message.includes('try again')
  );
}

function isTransientThreadsError(err) {
  const apiErr = err.response?.data?.error || {};
  const status = Number(err.response?.status || 0),
    code = Number(apiErr.code || 0);
  const message = String(apiErr.message || apiErr.error_user_msg || err.message || '').toLowerCase();
  return (
    apiErr.is_transient === true ||
    status >= 500 ||
    [1, 2, 4, 17, 32].includes(code) ||
    message.includes('retry your request later') ||
    message.includes('temporary') ||
    message.includes('temporarily') ||
    message.includes('try again')
  );
}

function isInvalidCarouselChildrenError(err) {
  const apiErr = err.response?.data?.error || {};
  const title = String(apiErr.error_user_title || '').toLowerCase();
  const msg = String(apiErr.error_user_msg || apiErr.message || err.message || '').toLowerCase();
  return (
    Number(apiErr.error_subcode) === 4279004 ||
    title.includes('invalid carousel children') ||
    msg.includes('invalid carousel children') ||
    msg.includes('children with ids')
  );
}

// A media attempt may fall back to re-publishing the same text without media only if the first
// attempt provably did not publish. publishContainer() tags /threads_publish failures with
// publishOutcomeUnknown (Threads may have published anyway, e.g. a 500 after accepting) - those
// must propagate so publishQueue fails closed instead of posting a text-only duplicate.
function canFallBackToText(err) {
  if (err?.publishOutcomeUnknown) return false;
  return isMediaProcessingError(err) || isTransientThreadsError(err);
}
function mediaProcessingError(message, details = {}) {
  const err = new Error(message);
  err.code = 'THREADS_MEDIA_PROCESSING_FAILED';
  err.isThreadsMediaProcessingError = true;
  Object.assign(err, details);
  return err;
}
function isMediaProcessingError(err) {
  return !!(
    err?.isThreadsMediaProcessingError ||
    err?.code === 'THREADS_MEDIA_PROCESSING_FAILED' ||
    /Threads 미디어 처리 실패|미디어 준비 시간 초과|미디어 컨테이너가 만료/i.test(String(err?.message || ''))
  );
}

module.exports = {
  GRAPH_BASE,
  sleep,
  resolveThreadsAppCreds,
  logThreadsError,
  isRetryablePublishError,
  isTransientThreadsError,
  isInvalidCarouselChildrenError,
  canFallBackToText,
  mediaProcessingError,
  isMediaProcessingError,
};
