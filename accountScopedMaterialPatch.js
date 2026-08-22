const fs = require('fs');
const path = require('path');
const { db } = require('./db');

if (!global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__) {
  global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__ = true;

  // 기존 전역 post_url UNIQUE 이력을 계정별(account_id + post_url) 이력으로 마이그레이션한다.
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
    console.warn('[Autopilot][ACCOUNT MATERIAL] DB 마이그레이션 실패:', e.message);
  }

  function replaceRequired(source, from, to, label) {
    if (!source.includes(from)) throw new Error(`${label} 패턴을 찾지 못했습니다`);
    return source.replace(from, to);
  }

  try {
    const benchmarkFile = path.join(__dirname, 'benchmarkAccounts.js');
    let source = fs.readFileSync(benchmarkFile, 'utf8');

    source = replaceRequired(
      source,
      `  CREATE TABLE IF NOT EXISTS threads_benchmark_used_posts (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    post_url TEXT NOT NULL UNIQUE,\n    used_at TEXT NOT NULL DEFAULT (datetime('now'))\n  );`,
      `  CREATE TABLE IF NOT EXISTS threads_benchmark_used_posts (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    account_id INTEGER NOT NULL,\n    post_url TEXT NOT NULL,\n    used_at TEXT NOT NULL DEFAULT (datetime('now')),\n    UNIQUE(account_id, post_url)\n  );`,
      'benchmark used table'
    );

    source = replaceRequired(
      source,
      `function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }\nfunction isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url)); }`,
      `function markUsedPost(accountId,url) { if (accountId&&url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (account_id,post_url) VALUES (?,?)').run(Number(accountId),String(url)); }\nfunction isUsedPost(accountId,url) { return !!(accountId&&url&&db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE account_id=? AND post_url=?').get(Number(accountId),String(url))); }`,
      'benchmark mark/is used'
    );

    source = replaceRequired(
      source,
      `async function collectBenchmarkMaterials({limit=10}={}){`,
      `async function collectBenchmarkMaterials({limit=10,accountId=null}={}){`,
      'benchmark collect signature'
    );

    source = replaceRequired(
      source,
      `.filter(x=>!isUsedPost(x.url))`,
      `.filter(x=>!accountId||!isUsedPost(accountId,x.url))`,
      'benchmark account filter'
    );

    fs.writeFileSync(benchmarkFile, source, 'utf8');
  } catch (e) {
    console.error('[Autopilot][ACCOUNT MATERIAL] benchmarkAccounts.js 패치 실패:', e.message);
    throw e;
  }

  try {
    const engineFile = path.join(__dirname, 'autopilotMaterialEngine.js');
    let source = fs.readFileSync(engineFile, 'utf8');

    source = replaceRequired(source, `async function pickThreadsMaterials(){`, `async function pickThreadsMaterials(accountId){`, 'engine pick signature');
    source = replaceRequired(source, `collectBenchmarkMaterials({limit:60})`, `collectBenchmarkMaterials({limit:60,accountId})`, 'engine collect account');
    source = replaceRequired(source, `async function collectQualifiedThreadsMaterials(maxQualified=6){`, `async function collectQualifiedThreadsMaterials(accountId,maxQualified=6){`, 'engine qualified signature');
    source = replaceRequired(source, `const candidates=await pickThreadsMaterials();`, `const candidates=await pickThreadsMaterials(accountId);`, 'engine pick account');
    source = replaceRequired(source, `const materials=await collectQualifiedThreadsMaterials(6);`, `const materials=await collectQualifiedThreadsMaterials(accountId,6);`, 'engine build account');

    const beforeCount = (source.match(/markUsedPost\(material\.url\)/g) || []).length;
    if (!beforeCount) throw new Error('engine markUsedPost 호출을 찾지 못했습니다');
    source = source.replace(/markUsedPost\(material\.url\)/g, 'markUsedPost(accountId,material.url)');

    fs.writeFileSync(engineFile, source, 'utf8');
    console.log(`[Autopilot][ACCOUNT MATERIAL] 계정별 소재 사용/버림/중복 분리 활성화 · markUsed=${beforeCount}곳 · benchmark pool shared`);
  } catch (e) {
    console.error('[Autopilot][ACCOUNT MATERIAL] autopilotMaterialEngine.js 패치 실패:', e.message);
    throw e;
  }
}
