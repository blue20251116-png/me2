'use strict';

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

    let hits = 0;
    if (source.includes(visionCatch)) { source = source.replace(visionCatch, visionReplacement); hits++; }
    if (source.includes(textCatch)) { source = source.replace(textCatch, textReplacement); hits++; }
    console.log(`[Autopilot][RUNTIME STABILITY] engine budget propagation ${hits===2?'ON':'PARTIAL('+hits+'/2)'}`);
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

  if (base === 'strongStyleSecretAffiliatePatch.js' && !patched.has(base)) {
    const marker = "  const base = stripTerminalPeriods(commentLead)\n    .replace(new RegExp(`\\\\n*여기\\\\s+${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\s+살짝[\\\\s\\\\S]*$`, 'i'), '')\n    .trim();";
    const replacement = "  const base = stripTerminalPeriods(commentLead)\n    .replace(/\\n*여기\\s+[^\\n]{1,120}\\s+살짝\\s+더해봐\\s*\\n이게\\s+진짜\\s+킥이야ㅋㅋ\\s*$/i, '')\n    .trim();";
    if (source.includes(marker)) {
      source = source.replace(marker, replacement);
      console.log('[Autopilot][RUNTIME STABILITY] secret bridge dedupe ON');
    } else {
      console.warn('[Autopilot][RUNTIME STABILITY] secret bridge dedupe marker MISS');
    }
    patched.add(base);
  }

  if (base === 'threadsApi.js' && !patched.has(base)) {
    const marker = "  return publishContainer(creationId,accessToken,3,2000);\n}";
    const replacement = "  const replyReadyWaitMs=Math.max(1000,Number(process.env.THREADS_REPLY_READY_WAIT_MS||2500));\n  console.log(`[Threads][REPLY_READY_WAIT] creationId=${creationId} wait=${replyReadyWaitMs}ms`);\n  await sleep(replyReadyWaitMs);\n  return publishContainer(creationId,accessToken,3,2500);\n}";
    if (source.includes(marker)) {
      source = source.replace(marker, replacement);
      console.log('[Threads][RUNTIME STABILITY] reply publish readiness wait ON');
    } else {
      console.warn('[Threads][RUNTIME STABILITY] reply publish readiness marker MISS');
    }
    patched.add(base);
  }

  if (base === 'geminiEmergencyFallbackPatch.js' && !patched.has(base)) {
    const oldReturn = "    return !!(e?.isGeminiRateLimit || e?.code === 'GEMINI_COOLDOWN' || /prepayment credits are depleted|quota exceeded|gemini cooldown|\\b429\\b/i.test(msg));";
    const newReturn = "    return !!(e?.isGeminiRateLimit || e?.code === 'GEMINI_COOLDOWN' || e?.code === 'OPENAI_HOURLY_BUDGET_EXCEEDED' || e?.__openAiNoRetry || /prepayment credits are depleted|quota exceeded|gemini cooldown|OPENAI_HOURLY_BUDGET_EXCEEDED|no credits remaining|add credits|\\b429\\b/i.test(msg));";
    if (source.includes(oldReturn)) {
      source = source.replace(oldReturn, newReturn)
        .replace('Gemini 429/크레딧 소진 감지 → 원문 쿠팡링크 기반 비상발행 전환','AI 호출 제한/크레딧 소진 감지 → 원문 쿠팡링크 기반 비상발행 전환')
        .replace('Gemini 429/크레딧 소진 시 AI 없는 원문링크 기반 비상발행 활성화','AI 호출 제한/크레딧 소진 시 AI 없는 원문링크 기반 비상발행 활성화');
      console.log('[Autopilot][RUNTIME STABILITY] AI emergency fallback propagation ON');
    } else {
      console.warn('[Autopilot][RUNTIME STABILITY] emergency fallback marker MISS');
    }
    patched.add(base);
  }

  return originalCompile.call(this, source, filename);
};

console.log('[Runtime Stability] patch armed · budget propagation + no double fallback + reply readiness + recipe bridge dedupe');
