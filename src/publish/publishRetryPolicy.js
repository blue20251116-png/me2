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

module.exports = { MAX_PUBLISH_ATTEMPTS, publishRetryable, hasKnownExternalCreation, classifyPublishFailure };
