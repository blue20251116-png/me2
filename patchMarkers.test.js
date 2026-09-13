'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// REGRESSION (found live, 2026-09-13): runtimeStabilityPatch.js and videoFrameVisionPatch.js both
// do Module.prototype._compile string-marker patching against autopilotMaterialEngine.js/
// recipeQualityPatch.js - injecting real behavior (budget-guard propagation, video-frame vision
// extraction) only when an exact literal string still appears in the target file's source. Since
// patching happens in-memory only, never touching the file on disk, a marker that stops matching
// doesn't error - it just silently no-ops forever (a "MISS" log line nobody watches). This exact
// thing just happened: an unrelated one-line fix inserted new code ABOVE identifyCommerceTarget()'s
// existing prologue, which was also videoFrameVisionPatch.js's marker - only caught by chance via
// a full `npm start` boot log, not by the test suite. These tests make that kind of drift fail
// `node --test` immediately instead of silently disabling a production feature.
//
// If a marker check below ever legitimately needs to change (a deliberate edit to the matched
// code), update the corresponding string in runtimeStabilityPatch.js or videoFrameVisionPatch.js
// in the SAME commit, then update the copy here to match - the two must never drift apart.

const engineSource = fs.readFileSync(require.resolve('./autopilotMaterialEngine.js'), 'utf8');
const recipeSource = fs.readFileSync(require.resolve('./recipeQualityPatch.js'), 'utf8');

test('videoFrameVisionPatch.js marker still matches identifyCommerceTarget()\'s prologue', () => {
  const marker = "async function identifyCommerceTarget(accountId,m){\n  const images=(Array.isArray(m.images)?m.images:[]).filter(Boolean).slice(0,3);\n  const system=commerceTargetPrompt();\n  const text=commerceTargetText(m);";
  assert.ok(engineSource.includes(marker), 'videoFrameVisionPatch.js will silently disable video-frame vision extraction (MISS) if this fails');
});

test('runtimeStabilityPatch.js markers still match autopilotMaterialEngine.js\'s three catch blocks', () => {
  const visionCatch = "    }catch(e){\n      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    }";
  const textCatch = "  }catch(e){\n    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};\n  }";
  const tryCatch = "    }catch(e){\n      lastError=e;\n      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);\n      if(coupangApi.isRateLimitError?.(e))throw e;\n      markUsedPost(material.url);\n    }";
  assert.ok(engineSource.includes(visionCatch), 'runtimeStabilityPatch.js will silently skip budget-guard propagation in the vision-target catch (MISS) if this fails');
  assert.ok(engineSource.includes(textCatch), 'runtimeStabilityPatch.js will silently skip budget-guard propagation in the text-target catch (MISS) if this fails');
  assert.ok(engineSource.includes(tryCatch), 'runtimeStabilityPatch.js will silently skip budget-guard propagation in the per-material try/catch (MISS) if this fails');
});

test('runtimeStabilityPatch.js marker still matches recipeQualityPatch.js\'s catch block', () => {
  const marker = "    } catch (e) {\n      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);\n    }";
  assert.ok(recipeSource.includes(marker), 'runtimeStabilityPatch.js will silently skip budget-guard propagation in the recipe rewrite catch (MISS) if this fails');
});
