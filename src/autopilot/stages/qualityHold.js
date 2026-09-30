'use strict';

// REGRESSION (found live, 2026-09-13, in direct response to a user question about Claude credit
// exhaustion): this regex was written for OpenAI's old phrasing and never updated for the
// OpenAI->Claude migration earlier today. Anthropic's actual insufficient-credit error reads
// "Your credit balance is too low to access the Claude API..." - matching none of the listed
// phrases - so a real Claude credit-exhaustion error would fail this text check (the __openAiNoRetry
// flag set upstream by aiRequestGuard.js's isNoCredits() already covers the common case,
// but this is the independent, defense-in-depth signal this function was designed to also check).
function isGeminiDown(e) {
  const msg = `${e?.message || ''} ${e?.response?.data?.error?.message || ''}`;
  return !!(
    e?.isGeminiRateLimit ||
    e?.code === 'GEMINI_COOLDOWN' ||
    e?.code === 'OPENAI_HOURLY_BUDGET_EXCEEDED' ||
    e?.__openAiNoRetry ||
    /prepayment credits are depleted|quota exceeded|gemini cooldown|OPENAI_HOURLY_BUDGET_EXCEEDED|no credits remaining|add credits|credit balance is too low|insufficient_quota|\b429\b/i.test(
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

module.exports = { isGeminiDown, qualityHoldError };
