'use strict';

const MAX_PUBLISH_ATTEMPTS = 3;

function publishRetryable(err) {
  const status = Number(err?.response?.status || 0);
  return (
    status === 429 || status >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(err?.code)
  );
}

function hasKnownExternalCreation(err) {
  return !!(err?.creationId || err?.threadsCreationId || err?.publishOutcomeUnknown);
}

// 2026-11-05 (marketing c1266546): ERR_CANCELED is axios's code when the per-request deadline
// (infra/httpDeadline AbortSignal) fires - in practice a timeout, e.g. a slow video container create
// (#8798). Before any container is known nothing can be live, so it gets exactly one retry (first
// attempt only). With a known container it stays outcome-unknown and goes to publishRecovery.
function canceledRetryable(err, nextAttempts) {
  return err?.code === 'ERR_CANCELED' && nextAttempts === 1;
}

function classifyPublishFailure(err, attempts) {
  const nextAttempts = Number(attempts || 0) + 1;
  const unknownOutcome = hasKnownExternalCreation(err);
  const canRetry =
    !unknownOutcome &&
    nextAttempts < MAX_PUBLISH_ATTEMPTS &&
    (publishRetryable(err) || canceledRetryable(err, nextAttempts));
  return {
    attempts: nextAttempts,
    retry: canRetry,
    outcomeUnknown: unknownOutcome,
    retryDelayMs: canRetry ? nextAttempts * 5 * 60 * 1000 : 0,
  };
}

// 11/13 (AI company dev 1ea14eaf): 10/23 posts 7771 and 7772 failed with only "ERR_BAD_REQUEST" saved, so nobody could tell
// why Threads refused them. The saved message now carries what the Threads API answered (HTTP status, error message, type,
// code, subcode, the user-facing text). Only the response's error object is read: never the request, its URL or the token.
function publishErrorText(err, max = 500) {
  const res = err && err.response;
  const e = (res && res.data && typeof res.data === 'object' && res.data.error) || null;
  const parts = [String((err && (err.code || err.message)) || 'PUBLISH_FAILED')];
  if (res && res.status) parts.push(`HTTP ${res.status}`);
  if (e) {
    if (e.message) parts.push(String(e.message));
    const ids = [e.type, e.code != null ? `code ${e.code}` : '', e.error_subcode != null ? `subcode ${e.error_subcode}` : ''].filter(Boolean);
    if (ids.length) parts.push(`(${ids.join(', ')})`);
    if (e.error_user_msg) parts.push(String(e.error_user_msg));
  }
  return parts.join(' ').replace(/access_token=[^&\s]+/gi, 'access_token=***').slice(0, max);
}

module.exports = { MAX_PUBLISH_ATTEMPTS, publishRetryable, hasKnownExternalCreation, classifyPublishFailure, publishErrorText };
