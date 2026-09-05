const fs = require('fs');
const path = require('path');
const Module = require('module');
const { db } = require('./db');

if (!global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__) {
  global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__ = true;

  // Material success/failure history must never exhaust the benchmark pool.
  // Drop the legacy used-post table and make benchmark used tracking a no-op.
  try {
    db.exec(`DROP TABLE IF EXISTS threads_benchmark_used_posts`);
    console.log('[Autopilot][ACCOUNT MATERIAL] used-post DB 제거 완료 · 성공/실패 소재 저장 안 함 · benchmark 재사용 허용');
  } catch (e) {
    console.error('[Autopilot][ACCOUNT MATERIAL] used-post DB 제거 실패:', e.message);
    throw e;
  }

  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function noUsedMaterialLoader(mod, filename) {
    if (!filename.endsWith(`${path.sep}benchmarkAccounts.js`)) {
      return originalJs(mod, filename);
    }

    let source = fs.readFileSync(filename, 'utf8');
    const oldFns = "function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }\nfunction isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url)); }";
    const noDbFns = "function markUsedPost(url) { return; }\nfunction isUsedPost(url) { return false; }";

    if (source.includes(oldFns)) {
      source = source.replace(oldFns, noDbFns);
    } else {
      // Fail closed at startup if benchmarkAccounts changes unexpectedly: do not silently
      // re-enable persistent material consumption.
      throw new Error('[ACCOUNT MATERIAL] benchmark mark/is used 패턴을 찾지 못했습니다');
    }

    console.log('[Autopilot][ACCOUNT MATERIAL] DB 사용이력 필터 OFF · markUsedPost=NOOP · isUsedPost=false');
    mod._compile(source, filename);
  };
}
