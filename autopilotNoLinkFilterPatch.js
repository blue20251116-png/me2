const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
let checked = false;

Module._extensions['.js'] = function affiliateLinkPolicyLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  const source = fs.readFileSync(filename, 'utf8');
  const requiredPattern = "if(!hasAffiliateLink(authorReplies))throw new Error('작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');";
  const applied = source.includes(requiredPattern);
  checked = true;

  if (!applied) {
    console.warn('[Autopilot][AFFILIATE LINK POLICY] 링크 필수검사 패턴을 찾지 못했습니다 patchApplied=no');
  } else {
    console.log('[Autopilot][AFFILIATE LINK POLICY] 작성자 쇼핑링크 필수 + 실제 검증 유지 patchApplied=yes');
  }

  // 엔진의 링크 필수검사를 제거하지 않는다. benchmarkAccounts가 실제 작성자 댓글/페이지에서
  // 감지한 링크를 authorReplies에 주입하므로 링크가 있는 소재만 통과한다.
  mod._compile(source, filename);
};

process.on('exit', () => {
  if (!checked) return;
});
