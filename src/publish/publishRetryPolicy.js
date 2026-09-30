'use strict';

const MAX_PUBLISH_ATTEMPTS = 3;

function publishRetryable(err) {
  const status = Number(err?.response?.status || 0);
  return status === 429 || status >= 500 || ['ECONNRESET','ETIMEDOUT','ECONNABORTED','EAI_AGAIN'].includes(err?.code);
}

function hasKnownExternalCreation(err) {
  return !!(err?.creationId || err?.threadsCreationId || err?.publishOutcomeUnknown);
}

function classifyPublishFailure(err, attempts) {
  const nextAttempts = Number(attempts || 0) + 1;
  const unknownOutcome = hasKnownExternalCreation(err);
  const canRetry = !unknownOutcome && nextAttempts < MAX_PUBLISH_ATTEMPTS && publishRetryable(err);
  return {
    attempts: nextAttempts,
    retry: canRetry,
    outcomeUnknown: unknownOutcome,
    retryDelayMs: canRetry ? nextAttempts * 5 * 60 * 1000 : 0,
  };
}

module.exports = { MAX_PUBLISH_ATTEMPTS, publishRetryable, hasKnownExternalCreation, classifyPublishFailure };
