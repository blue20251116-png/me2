const fs = require('fs');
const path = require('path');
const Module = require('module');
const { db } = require('./db');

if (!global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__) {
  global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__ = true;

  // Material success/failure history must never exhaust the benchmark pool.
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
      throw new Error('[ACCOUNT MATERIAL] benchmark mark/is used 패턴을 찾지 못했습니다');
    }

    // Railway's anonymous Chromium is currently being sent to Threads' login/error shell.
    // Reuse an authenticated Playwright storageState from the persistent /app/db volume.
    // Bootstrap can be supplied once through THREADS_STORAGE_STATE_JSON; refreshed cookies
    // are written back before each context closes, so deploy/restart does not discard them.
    const browserMarker = "  const context = await browser.newContext({\n    locale:'ko-KR',\n    viewport:{width:1100,height:1500},\n    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'\n  });\n  return { browser, context };";
    const browserReplacement = [
      "  const statePath=process.env.THREADS_STORAGE_STATE_PATH||'/app/db/threads-storage-state.json';",
      "  let storageState=null;",
      "  try {",
      "    if (fs.existsSync(statePath)) storageState=JSON.parse(fs.readFileSync(statePath,'utf8'));",
      "    else if (process.env.THREADS_STORAGE_STATE_JSON) {",
      "      storageState=JSON.parse(process.env.THREADS_STORAGE_STATE_JSON);",
      "      fs.mkdirSync(path.dirname(statePath),{recursive:true});",
      "      fs.writeFileSync(statePath,JSON.stringify(storageState),{mode:0o600});",
      "    }",
      "  } catch(e) { console.error('[Threads][SESSION] storageState load failed:',e.message); storageState=null; }",
      "  const context = await browser.newContext({",
      "    locale:'ko-KR',",
      "    viewport:{width:1100,height:1500},",
      "    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',",
      "    ...(storageState?{storageState}:{})",
      "  });",
      "  const originalClose=context.close.bind(context);",
      "  context.close=async()=>{",
      "    try { fs.mkdirSync(path.dirname(statePath),{recursive:true}); await context.storageState({path:statePath}); try{fs.chmodSync(statePath,0o600);}catch{} }",
      "    catch(e){ console.error('[Threads][SESSION] storageState save failed:',e.message); }",
      "    return originalClose();",
      "  };",
      "  console.log(`[Threads][SESSION] collector session=${storageState?'RESTORED':'ANONYMOUS'} path=${statePath}`);",
      "  return { browser, context };"
    ].join('\n');
    if (!source.includes(browserMarker)) throw new Error('[ACCOUNT MATERIAL] Threads browser session marker not found');
    source = source.replace(browserMarker, browserReplacement);

    // This loader is the effective owner of benchmarkAccounts.js in isolated workers.
    const evalStart = "    return await page.evaluate(({username,limit}) => {";
    const evalStartReplacement = [
      "    const __profileDiag=await page.evaluate(()=>({",
      "      finalUrl:location.href,",
      "      title:String(document.title||'').slice(0,160),",
      "      anchors:document.querySelectorAll('a').length,",
      "      postLinks:document.querySelectorAll('a[href*=\"/post/\"]').length,",
      "      articles:document.querySelectorAll('article,[role=\"article\"]').length,",
      "      hrefSamples:[...document.querySelectorAll('a[href]')].map(a=>{try{return new URL(a.href,location.origin).pathname}catch{return ''}}).filter(Boolean).slice(0,12),",
      "      bodyText:String(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,220)",
      "    }));",
      "    const __profileResult=await page.evaluate(({username,limit}) => {"
    ].join('\n');
    const evalEnd = "    }, {username,limit});\n  } finally { try{await page.close();}catch{} }";
    const evalEndReplacement = [
      "    }, {username,limit});",
      "    const __diagMsg=`@${username} final=${__profileDiag.finalUrl} title=${JSON.stringify(__profileDiag.title)} postLinks=${__profileDiag.postLinks} anchors=${__profileDiag.anchors} articles=${__profileDiag.articles} hrefs=${JSON.stringify(__profileDiag.hrefSamples)} body=${JSON.stringify(__profileDiag.bodyText)}`;",
      "    if(__profileResult.length) console.log(`[Threads][PROFILE OK] ${__diagMsg} posts=${__profileResult.length}`);",
      "    else console.error(`[Threads][PROFILE EMPTY] ${__diagMsg}`);",
      "    return __profileResult;",
      "  } finally { try{await page.close();}catch{} }"
    ].join('\n');

    if (!source.includes(evalStart) || !source.includes(evalEnd)) {
      throw new Error('[ACCOUNT MATERIAL] Threads profile diagnostic markers not found');
    }
    source = source.replace(evalStart, evalStartReplacement).replace(evalEnd, evalEndReplacement);

    console.log('[Autopilot][ACCOUNT MATERIAL] DB 사용이력 필터 OFF · markUsedPost=NOOP · isUsedPost=false');
    console.log('[Threads][SESSION] persistent collector storageState support armed');
    console.log('[Threads][COLLECTOR DIAG] effective worker diagnostics armed');
    mod._compile(source, filename);
  };
}
