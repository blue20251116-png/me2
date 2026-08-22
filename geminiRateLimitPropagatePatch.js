'use strict';

const fs = require('fs');
const path = require('path');

if (!global.__ME2_GEMINI_RATE_LIMIT_PROPAGATE_PATCH__) {
  global.__ME2_GEMINI_RATE_LIMIT_PROPAGATE_PATCH__ = true;

  const originalReadFileSync = fs.readFileSync.bind(fs);
  fs.readFileSync = function patchedReadFileSync(filename, ...args) {
    const result = originalReadFileSync(filename, ...args);
    const name = String(filename || '');
    if (!name.endsWith(`${path.sep}autopilotMaterialEngine.js`)) return result;

    let src = Buffer.isBuffer(result) ? result.toString('utf8') : String(result);
    let changed = 0;

    const imageCatch = "    }catch(e){\n      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    }";
    const imageCatchNew = "    }catch(e){\n      if(e?.isGeminiRateLimit){\n        console.warn(`[AutopilotV3][GEMINI DEFER] Vision 429/cooldown → 텍스트 fallback 없이 즉시 계정 이월`);\n        throw e;\n      }\n      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    }";
    if (src.includes(imageCatch)) { src = src.replace(imageCatch, imageCatchNew); changed++; }

    const textCatch = "  }catch(e){\n    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};\n  }";
    const textCatchNew = "  }catch(e){\n    if(e?.isGeminiRateLimit){\n      console.warn(`[AutopilotV3][GEMINI DEFER] Text 429/cooldown → confidence=0 처리 없이 즉시 계정 이월`);\n      throw e;\n    }\n    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);\n    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};\n  }";
    if (src.includes(textCatch)) { src = src.replace(textCatch, textCatchNew); changed++; }

    const tryCatch = "    }catch(e){\n      lastError=e;\n      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);\n      if(coupangApi.isRateLimitError?.(e))throw e;\n      markUsedPost(material.url);\n    }";
    const tryCatchNew = "    }catch(e){\n      if(e?.isGeminiRateLimit){\n        console.warn(`[AutopilotV3][GEMINI DEFER] @${material.username||'-'} 429/cooldown → 소재 보존 + 즉시 계정 이월`);\n        throw e;\n      }\n      lastError=e;\n      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);\n      if(coupangApi.isRateLimitError?.(e))throw e;\n      markUsedPost(material.url);\n    }";
    if (src.includes(tryCatch)) { src = src.replace(tryCatch, tryCatchNew); changed++; }

    if (!global.__ME2_GEMINI_RATE_LIMIT_PROPAGATE_LOGGED__) {
      global.__ME2_GEMINI_RATE_LIMIT_PROPAGATE_LOGGED__ = true;
      console.log(`[Autopilot][GEMINI PROPAGATE] 429/cooldown 즉시 상위 전달 활성화 · confidence=0 금지 · 후보 소진 금지 · replacements=${changed}`);
    }

    if (changed < 2 && !src.includes('[AutopilotV3][GEMINI DEFER]')) {
      console.warn(`[Autopilot][GEMINI PROPAGATE] 예상 패턴 일부 미적용 replacements=${changed}`);
    }

    return Buffer.isBuffer(result) ? Buffer.from(src, 'utf8') : src;
  };
}
