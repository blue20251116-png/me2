const fs = require('fs');
const path = require('path');
const Module = require('module');
const { db } = require('./db');

if (!global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__) {
  global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__ = true;

  try {
    const cols = db.prepare(`PRAGMA table_info(threads_benchmark_used_posts)`).all();
    const hasAccountId = cols.some(c => c.name === 'account_id');

    if (cols.length && !hasAccountId) {
      db.exec(`
        ALTER TABLE threads_benchmark_used_posts RENAME TO threads_benchmark_used_posts_legacy_global;
        CREATE TABLE threads_benchmark_used_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          post_url TEXT NOT NULL,
          used_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(account_id, post_url)
        );
        DROP TABLE threads_benchmark_used_posts_legacy_global;
      `);
      console.log('[Autopilot][ACCOUNT MATERIAL] 기존 전역 소재 사용이력 초기화 + 계정별 이력 테이블 마이그레이션 완료');
    } else if (!cols.length) {
      db.exec(`
        CREATE TABLE threads_benchmark_used_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          post_url TEXT NOT NULL,
          used_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(account_id, post_url)
        );
      `);
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_benchmark_used_account_url ON threads_benchmark_used_posts(account_id, post_url)`);
  } catch (e) {
    console.error('[Autopilot][ACCOUNT MATERIAL] DB 마이그레이션 실패:', e.message);
    throw e;
  }

  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function accountScopedBenchmarkLoader(mod, filename) {
    if (!filename.endsWith(`${path.sep}benchmarkAccounts.js`)) {
      return originalJs(mod, filename);
    }

    let source = fs.readFileSync(filename, 'utf8');
    const oldFns = "function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }\nfunction isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url)); }";
    const newFns = "function currentMaterialAccountId(){return Number(global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID||0);}\nfunction markUsedPost(url) { const accountId=currentMaterialAccountId(); if (accountId&&url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (account_id,post_url) VALUES (?,?)').run(accountId,String(url)); }\nfunction isUsedPost(url) { const accountId=currentMaterialAccountId(); return !!(accountId&&url&&db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE account_id=? AND post_url=?').get(accountId,String(url))); }";

    if (source.includes(oldFns)) {
      source = source.replace(oldFns, newFns);
    } else if (!source.includes('currentMaterialAccountId()')) {
      throw new Error('[ACCOUNT MATERIAL] benchmark mark/is used 패턴을 찾지 못했습니다');
    }

    console.log('[Autopilot][ACCOUNT MATERIAL] 계정별 소재 사용/버림/중복 분리 활성화 · benchmark pool shared · disk untouched');
    mod._compile(source, filename);
  };
}
