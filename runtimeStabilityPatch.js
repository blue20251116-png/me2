'use strict';
require('./httpDeadline');

const Module = require('module');
const path = require('path');

const originalCompile = Module.prototype._compile;
const patched = new Set();

function budgetGuardLine() {
  return "if(e?.code==='OPENAI_HOURLY_BUDGET_EXCEEDED'||e?.__openAiNoRetry||/OPENAI_HOURLY_BUDGET_EXCEEDED|no credits remaining|add credits/i.test(String(e?.message||'')+' '+String(e?.response?.data?.error?.message||''))){throw e;}";
}

Module.prototype._compile = function runtimeStabilityCompile(content, filename) {
  const base = path.basename(filename);
  let source = String(content || '');

  if (base === 'autopilotMaterialEngine.js' && !patched.has(base)) {
    const visionCatch = "    }catch(e){\n      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    }";
    const visionReplacement = "    }catch(e){\n      " + budgetGuardLine() + "\n      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    }";
    const textCatch = "  }catch(e){\n    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};\n  }";
    const textReplacement = "  }catch(e){\n    " + budgetGuardLine() + "\n    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};\n  }";
    const tryCatch = "    }catch(e){\n      lastError=e;\n      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);\n      if(coupangApi.isRateLimitError?.(e))throw e;\n      markUsedPost(material.url);\n    }";
    const tryReplacement = "    }catch(e){\n      lastError=e;\n      " + budgetGuardLine() + "\n      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);\n      if(coupangApi.isRateLimitError?.(e))throw e;\n      markUsedPost(material.url);\n    }";

    let hits = 0;
    if (source.includes(visionCatch)) { source = source.replace(visionCatch, visionReplacement); hits++; }
    if (source.includes(textCatch)) { source = source.replace(textCatch, textReplacement); hits++; }
    if (source.includes(tryCatch)) { source = source.replace(tryCatch, tryReplacement); hits++; }
    console.log(`[Autopilot][RUNTIME STABILITY] engine budget propagation ${hits===3?'ON':'PARTIAL('+hits+'/3)'}`);
    patched.add(base);
  }

  if (base === 'recipeQualityPatch.js' && !patched.has(base)) {
    const marker = "    } catch (e) {\n      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);\n    }";
    const replacement = "    } catch (e) {\n      " + budgetGuardLine() + "\n      console.warn(`[AutopilotV3][RECIPE SOURCE CHECK] 재작성 실패: ${e.response?.data?.error?.message || e.message}`);\n    }";
    if (source.includes(marker)) {
      source = source.replace(marker, replacement);
      console.log('[Autopilot][RUNTIME STABILITY] recipe budget propagation ON');
    } else {
      console.warn('[Autopilot][RUNTIME STABILITY] recipe budget propagation marker MISS');
    }
    patched.add(base);
  }

  // The strongStyleSecretAffiliatePatch.js, threadsApi.js, and geminiEmergencyFallbackPatch.js
  // string-replace branches that used to live here were removed (hourly review, 2026-09-12):
  // all three target files have since been directly edited to permanently include the exact
  // behavior these branches existed to inject (confirmed by grepping each file - the OLD marker
  // text these branches searched for no longer exists anywhere in them, only the intended NEW
  // behavior, already baked in). Since Module.prototype._compile patches the in-memory source
  // only and never touches the file on disk, an exact-string marker that stops matching doesn't
  // error - it just silently no-ops (logging a "MISS" warning nobody watches) forever. All three
  // had already reached that permanently-dead state before this cleanup; removing them changes
  // no runtime behavior, since a MISS branch was never doing anything anyway.
  return originalCompile.call(this, source, filename);
};

console.log('[Runtime Stability] patch armed · engine + recipe budget propagation');
