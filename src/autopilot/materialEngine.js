'use strict';
const { isAiBudgetOrCreditError } = require('../integrations/aiRequestGuard');
// One autopilot attempt: pick material → analyze → match product → write post. Called by pipeline.js.
const coupangApi = require('../integrations/coupangApi');
const { clean, decodeEscapedNewlines } = require('./aiCalls');
const {
  preferredContentSlot,
  advanceContentMode,
  specialStoryScore,
  isSpecialStoryCandidate,
  localStrongContentMode,
} = require('./contentMode');
const { collectQualifiedThreadsMaterials } = require('./materials');
const { confidence01, productMatchOk, buildSoldFirstTerms, findProduct } = require('./productMatching');
const { generatePost } = require('./postWriter');
const { identifyCommerceTarget, analyzeMaterial } = require('./vision');

async function buildThreadsFirstAutopilot(accountId, { target }) {
  const materials = await collectQualifiedThreadsMaterials(3);
  const preferredSlot = preferredContentSlot(accountId);
  const preferredMode = preferredSlot.mode;
  const specialStoryWanted = preferredSlot.specialStory === true;
  console.log(
    `[AutopilotV3][CONTENT MIX] account=${accountId} target=50/50/0 preferred=${preferredMode} specialStory=${specialStoryWanted ? 'ON' : 'OFF'} sourceVoice=v2 lifestyle=0%`
  );
  let lastError = null;
  for (let idx = 0; idx < materials.length; idx++) {
    const material = materials[idx];
    try {
      console.log(
        `[AutopilotV3][TRY] ${idx + 1}/${materials.length} @${material.username || '-'} source=${material.url}`
      );
      const sourceClaimsVideo = !!material.hasVideo || Number(material.videoCount || 0) > 0;
      const playableVideos = Array.isArray(material.videos) ? material.videos.filter(Boolean) : [];
      if (sourceClaimsVideo && !playableVideos.length) {
        lastError = new Error('원본 영상 존재 확인됨 · 현재 영상 URL 추출 실패');
        console.log(
          `[AutopilotV3][VIDEO QUALITY SKIP] @${material.username || '-'} hasVideo=yes playable=0 → 이미지 강등 금지 · 다음 소재`
        );
        continue;
      }
      const localMode = localStrongContentMode(material);
      if (localMode && localMode !== preferredMode) {
        console.log(
          `[AutopilotV3][LOCAL PREFILTER DEFER] preferred=${preferredMode} local=${localMode} @${material.username || '-'} → 후보 유지 · Vision/실제 판정 계속`
        );
      }
      const vision = await identifyCommerceTarget(accountId, material);
      const conf = confidence01(vision?.confidence);
      if (conf < 0.5) {
        lastError = new Error(`판매 대상 신뢰도 부족 confidence=${vision?.confidence ?? 0}`);
        console.log(
          `[AutopilotV3][CONFIDENCE SKIP] @${material.username || '-'} confidence=${vision?.confidence ?? 0} normalized=${conf.toFixed(2)} → 상품 연결 금지 · 다음 소재`
        );
        continue;
      }
      const analysis = await analyzeMaterial(accountId, material, target, vision);
      if (preferredMode === 'product' && analysis.mode === 'lifestyle' && analysis.searchTerms.length > 0) {
        analysis.mode = 'product';
        console.log(
          `[AutopilotV3][CONTENT MIX PRODUCT LOCK] preferred=product got=lifestyle sellable=yes → source-preserve product`
        );
      }
      if (preferredMode === 'lifestyle' && analysis.mode !== 'lifestyle') {
        const detected = analysis.mode;
        analysis.mode = 'lifestyle';
        console.log(
          `[AutopilotV3][LIFESTYLE SLOT LOCK] preferred=lifestyle detected=${detected} → 10% lifestyle 슬롯 강제`
        );
      }
      if (analysis.mode === 'lifestyle') {
        console.log(
          `[AutopilotV3][NO LIFESTYLE SKIP] @${material.username || '-'} lifestyle 소재 → 발행 제외 · 다음 후보`
        );
        continue;
      }
      if (analysis.mode !== preferredMode)
        console.log(
          `[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 후보 소모 없이 발행 시도`
        );
      const specialStory =
        analysis.mode === 'lifestyle' && specialStoryWanted && isSpecialStoryCandidate(material, analysis, vision);
      if (analysis.mode === 'lifestyle' && specialStoryWanted && !specialStory)
        console.log(
          `[AutopilotV3][SPECIAL STORY FALLBACK] score=${specialStoryScore(material, analysis, vision)} → 일반 lifestyle로 발행 시도`
        );
      if (specialStory)
        console.log(
          `[AutopilotV3][SPECIAL STORY] selected score=${specialStoryScore(material, analysis, vision)} @${material.username || '-'}`
        );
      if (!analysis.searchTerms.length) {
        lastError = new Error(`Threads 소재 "${analysis.topic}"에서 구매 가능한 상품 검색어를 찾지 못했습니다`);
        console.log(`[AutopilotV3][SKIP] ${lastError.message} → 다음 소재`);
        continue;
      }
      const soldIdentity = clean(vision?.soldObject || analysis?.topic || '');
      analysis.searchTerms = buildSoldFirstTerms(analysis, vision);
      console.log(
        `[AutopilotV3][COUPANG SEARCH][SOLD-FIRST] sold="${soldIdentity || '-'}" 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`
      );
      const found = await findProduct(accountId, analysis.searchTerms, soldIdentity);
      if (!found.product) {
        lastError = new Error(`Threads 소재 기반 쿠팡 상품을 찾지 못했습니다: ${analysis.searchTerms.join(', ')}`);
        console.log(`[AutopilotV3][SKIP] ${lastError.message} → 다음 소재`);
        continue;
      }
      if (!productMatchOk(vision, found.product)) {
        lastError = new Error(
          `쿠팡 상품 매칭 불일치 sold="${vision?.soldObject || '-'}" product="${found.product.name || '-'}"`
        );
        console.log(
          `[AutopilotV3][PRODUCT MATCH SKIP] @${material.username || '-'} sold="${vision?.soldObject || '-'}" product="${found.product.name || '-'}" → 다음 소재`
        );
        continue;
      }
      const generated = await generatePost(accountId, {
        material,
        analysis: { ...analysis, specialStory: Boolean(specialStory) },
        product: found.product,
        target,
      });
      console.log(
        `[AutopilotV3][SUCCESS] @${material.username || '-'} product="${found.product.name}" mode=${analysis.mode} persona=${generated.persona} specialStory=${Boolean(specialStory)} sourcePreserve=${analysis.mode === 'lifestyle' ? 'OFF' : 'ON'}`
      );
      advanceContentMode(accountId);
      const textOnly = analysis.mode === 'lifestyle';
      if (textOnly) console.log('[AutopilotV3][LIFESTYLE TEXT ONLY] source media suppressed');
      return {
        text: decodeEscapedNewlines(generated.text),
        commentLead: decodeEscapedNewlines(generated.commentLead),
        product: found.product,
        productSearchTerm: found.searchTerm,
        mode: analysis.mode,
        persona: generated.persona,
        topic: analysis.topic,
        secretTerm: analysis.secretTerm,
        specialStory: Boolean(specialStory),
        sourceUrl: material.url,
        sourceUsername: material.username || null,
        sourceText: material.sourceText,
        authorReplies: material.authorReplies,
        sourceImages: textOnly
          ? []
          : Array.isArray(material.images)
            ? material.images.filter(Boolean).slice(0, 10)
            : [],
        sourceVideos: textOnly ? [] : Array.isArray(material.videos) ? material.videos.filter(Boolean).slice(0, 5) : [],
        referenceImage: textOnly ? null : material.images?.[0] || null,
        visionTarget: vision,
      };
    } catch (e) {
      lastError = e;
      if (isAiBudgetOrCreditError(e)) {
        throw e;
      }
      console.warn(
        `[AutopilotV3][TRY FAIL] @${material.username || '-'} ${e.response?.data?.error?.message || e.message} → 다음 소재`
      );
      if (coupangApi.isRateLimitError?.(e)) throw e;
    }
  }
  throw new Error(
    `쇼핑 소재 ${materials.length}개를 검사했지만 발행 가능한 상품 연결에 실패했습니다${lastError ? `: ${lastError.message}` : ''}`
  );
}

module.exports = { buildThreadsFirstAutopilot };
