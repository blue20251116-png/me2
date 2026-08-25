'use strict';

const engine = require('./autopilotMaterialEngine');

function isGeminiDown(e) {
  const msg = `${e?.message || ''} ${e?.response?.data?.error?.message || ''}`;
  return !!(
    e?.isGeminiRateLimit ||
    e?.code === 'GEMINI_COOLDOWN' ||
    e?.code === 'OPENAI_HOURLY_BUDGET_EXCEEDED' ||
    e?.__openAiNoRetry ||
    /prepayment credits are depleted|quota exceeded|gemini cooldown|OPENAI_HOURLY_BUDGET_EXCEEDED|no credits remaining|add credits|\b429\b/i.test(msg)
  );
}

function qualityHoldError(cause) {
  const err = new Error('AI 생성 경로가 호출 제한/크레딧 제한 상태라 저품질 고정문구 발행을 중단했습니다');
  err.code = 'CONTENT_QUALITY_HOLD';
  err.isContentQualityHold = true;
  err.cause = cause;
  return err;
}

if (!global.__ME2_GEMINI_EMERGENCY_FALLBACK__) {
  global.__ME2_GEMINI_EMERGENCY_FALLBACK__ = true;

  const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

  engine.buildThreadsFirstAutopilot = async function emergencyFallbackBuild(accountId, options) {
    try {
      return await originalBuild(accountId, options);
    } catch (e) {
      if (!isGeminiDown(e)) throw e;

      // 품질 우선: AI 호출 제한 시 예전 productBody()/recipeBody() 고정문구를 발행하지 않는다.
      // 소재를 사용 처리하지 않고 그대로 보존하여 AI 정상화 후 다시 시도할 수 있게 한다.
      console.warn('[AutopilotV3][QUALITY HOLD] AI 호출 제한/크레딧 제한 감지 → 고정문구 fallback 발행 차단 · 소재 보존');
      throw qualityHoldError(e);
    }
  };

  console.log('[Autopilot][QUALITY HOLD] v3 AI 호출 제한 시 저품질 emergency 고정문구 발행 금지 · 정상화 후 재시도');
}

module.exports = { isGeminiDown, qualityHoldError };
