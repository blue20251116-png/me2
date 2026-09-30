'use strict';

// AI quota / credit exhaustion in any provider's wording (defence in depth on top of
// aiRequestGuard's __openAiNoRetry flag).
function isAiQuotaExhausted(e) {
  const msg = `${e?.message || ''} ${e?.response?.data?.error?.message || ''}`;
  return !!(
    e?.code === 'OPENAI_HOURLY_BUDGET_EXCEEDED' ||
    e?.__openAiNoRetry ||
    /prepayment credits are depleted|quota exceeded|OPENAI_HOURLY_BUDGET_EXCEEDED|no credits remaining|add credits|credit balance is too low|insufficient_quota|\b429\b/i.test(
      msg
    )
  );
}

function qualityHoldError(cause) {
  const err = new Error('AI 생성 경로가 호출 제한/크레딧 제한 상태라 저품질 고정문구 발행을 중단했습니다');
  err.code = 'CONTENT_QUALITY_HOLD';
  err.isContentQualityHold = true;
  err.cause = cause;
  return err;
}

module.exports = { isAiQuotaExhausted, qualityHoldError };
