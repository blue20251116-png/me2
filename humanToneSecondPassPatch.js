const fs = require('fs');
const path = require('path');
const Module = require('module');

if (!global.__ME2_HUMAN_TONE_SECOND_PASS_PATCH__) {
  global.__ME2_HUMAN_TONE_SECOND_PASS_PATCH__ = true;
  const originalJs = Module._extensions['.js'];

  Module._extensions['.js'] = function humanToneSecondPassLoader(mod, filename) {
    if (path.basename(filename) !== 'autopilotHumanToneGuardPatch.js') {
      return originalJs(mod, filename);
    }

    let source = fs.readFileSync(filename, 'utf8');
    const oldBlock = "if(fixed&&next.length===0)return {...result,text:fixed};if(fixed&&isSoftLayoutOnly(next)){console.log(`[AutopilotV3][HUMAN FINAL] v8 SOFT-PASS layout-only reasons=${next.join(',')}`);return {...result,text:fixed};}throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 1회 교정 후에도 실패 reasons=${next.join(',')||'unknown'}`);";
    const newBlock = "if(fixed&&next.length===0)return {...result,text:fixed};if(fixed&&isSoftLayoutOnly(next)){console.log(`[AutopilotV3][HUMAN FINAL] v8 SOFT-PASS layout-only reasons=${next.join(',')}`);return {...result,text:fixed};}if(fixed&&next.length){const rewritten2=await rewriteOnce(key,fixed,result.mode,next);const fixed2=normalizeParagraphs(rewritten2);const next2=rejectReasons(fixed2);console.log(`[AutopilotV3][HUMAN FINAL] v8 SECOND-REWRITE reasons=${next2.join(',')||'PASS'} preview=\"${fixed2.slice(0,160).replace(/\\n/g,' / ')}\"`);if(fixed2&&next2.length===0)return {...result,text:fixed2};if(fixed2&&isSoftLayoutOnly(next2)){console.log(`[AutopilotV3][HUMAN FINAL] v8 SECOND-SOFT-PASS layout-only reasons=${next2.join(',')}`);return {...result,text:fixed2};}throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 2회 교정 후에도 실패 reasons=${next2.join(',')||'unknown'}`);}throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 교정 결과 없음 reasons=${next.join(',')||'unknown'}`);";

    if (!source.includes(oldBlock)) {
      console.warn('[Autopilot][HUMAN SECOND PASS] 대상 패턴을 찾지 못해 원본 로드');
      return originalJs(mod, filename);
    }

    source = source.replace(oldBlock, newBlock);
    console.log('[Autopilot][HUMAN SECOND PASS] 최종 문체 1차 실패 시 남은 사유만 2차 교정 활성화');
    mod._compile(source, filename);
  };
}
