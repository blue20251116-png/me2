'use strict';

const engine = require('./autopilotMaterialEngine');

if (!global.__ME2_GEMINI_EMERGENCY_FALLBACK__) {
  global.__ME2_GEMINI_EMERGENCY_FALLBACK__ = true;

  const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

  function isGeminiDown(e) {
    const msg = `${e?.message || ''} ${e?.response?.data?.error?.message || ''}`;
    return !!(
      e?.isGeminiRateLimit ||
      e?.code === 'GEMINI_COOLDOWN' ||
      /prepayment credits are depleted|quota exceeded|gemini cooldown|\b429\b/i.test(msg)
    );
  }

  function qualityHoldError(cause) {
    const err = new Error('AI 생성 경로가 429/크레딧 제한 상태라 저품질 고정문구 발행을 중단했습니다');
    err.code = 'CONTENT_QUALITY_HOLD';
    err.isContentQualityHold = true;
    err.cause = cause;
    return err;
  }

  engine.buildThreadsFirstAutopilot = async function emergencyFallbackBuild(accountId, options) {
    try {
      return await originalBuild(accountId, options);
    } catch (e) {
      if (!isGeminiDown(e)) throw e;

      // 중요: 예전처럼 productBody()/recipeBody() 고정 문구를 만들어 발행하지 않는다.
      // 정상 AI 문체 파이프라인을 우회한 결과는 HumanTone/ReactionTone/POST STYLE GUARD를
      // 통과하지 않으므로 계정 품질을 위해 해당 회차 발행 자체를 보류한다.
      // 소재도 여기서 markUsed 하지 않으므로 AI가 정상화된 뒤 다시 사용할 수 있다.
      console.warn('[AutopilotV3][QUALITY HOLD] AI 429/크레딧 제한 감지 → 고정문구 fallback 발행 차단 · 소재 보존');
      throw qualityHoldError(e);
    }
  };

  console.log('[Autopilot][QUALITY HOLD] v2 AI 429 시 저품질 emergency 고정문구 발행 금지 · 정상화 후 재시도');
}

module.exports = { isGeminiDown };
