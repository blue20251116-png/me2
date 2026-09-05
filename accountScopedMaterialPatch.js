const fs = require('fs');
const path = require('path');
const Module = require('module');
const { db } = require('./db');

if (!global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__) {
  global.__ME2_ACCOUNT_SCOPED_MATERIAL_PATCH__ = true;

  try {
    db.exec(`DROP TABLE IF EXISTS threads_benchmark_used_posts`);
    console.log('[Autopilot][ACCOUNT MATERIAL] used-post DB 제거 완료 · 성공/실패 소재 저장 안 함 · benchmark 재사용 허용');
  } catch (e) {
    console.error('[Autopilot][ACCOUNT MATERIAL] used-post DB 제거 실패:', e.message);
    throw e;
  }

  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function noUsedMaterialLoader(mod, filename) {
    if (!filename.endsWith(`${path.sep}benchmarkAccounts.js`)) return originalJs(mod, filename);

    let source = fs.readFileSync(filename, 'utf8');
    const oldFns = "function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }\nfunction isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url)); }";
    const noDbFns = "function markUsedPost(url) { return; }\nfunction isUsedPost(url) { return false; }";
    if (source.includes(oldFns)) source = source.replace(oldFns, noDbFns);
    else throw new Error('[ACCOUNT MATERIAL] benchmark mark/is used 패턴을 찾지 못했습니다');

    const oldCollector = "  const sample=accounts.slice(0,Math.min(accounts.length,12));\n  let browser,context;\n  try{\n    ({browser,context}=await openBrowser());\n    const perAccount=Math.max(8,Math.ceil(limit/Math.max(1,sample.length))+4);\n    const scanned=await mapWithConcurrency(sample,4,async account=>(await collectProfilePostsWithContext(context,account.username,{limit:perAccount})).filter(x=>!isUsedPost(x.url)));\n    const pools=scanned.filter(Array.isArray).filter(x=>x.length),all=[];let round=0;\n    while(all.length<limit&&pools.some(p=>p.length>round)){\n      for(const pool of shuffle(pools)){if(all.length>=limit)break;if(pool[round])all.push(pool[round]);}\n      round++;\n    }\n    console.log(`[Threads benchmark] accounts=${sample.length} pools=${pools.length} collected=${all.length} requested=${limit}`);\n    return all.slice(0,limit);";
    const resilientCollector = "  const batchSize=Math.max(4,Math.min(12,Number(process.env.THREADS_BENCHMARK_BATCH_SIZE||12)));\n  const maxAccounts=Math.max(batchSize,Math.min(accounts.length,Number(process.env.THREADS_BENCHMARK_MAX_SCAN||Math.min(accounts.length,72))));\n  let browser,context;\n  try{\n    ({browser,context}=await openBrowser());\n    const all=[],seen=new Set(); let scannedAccounts=0,successfulPools=0,challengeCount=0;\n    for(let offset=0;offset<maxAccounts&&all.length<limit;offset+=batchSize){\n      const batch=accounts.slice(offset,Math.min(offset+batchSize,maxAccounts));\n      if(!batch.length)break;\n      const perAccount=Math.max(12,Math.ceil((limit-all.length)/Math.max(1,batch.length))+8);\n      const scanned=await mapWithConcurrency(batch,2,async account=>{ const rows=await collectProfilePostsWithContext(context,account.username,{limit:perAccount}); if(rows&&rows.__threadsChallenge) challengeCount++; return (rows||[]).filter(x=>!isUsedPost(x.url)); });\n      scannedAccounts+=batch.length;\n      const pools=scanned.filter(Array.isArray).filter(x=>x.length); successfulPools+=pools.length;\n      let round=0;\n      while(all.length<limit&&pools.some(p=>p.length>round)){ for(const pool of shuffle(pools)){ if(all.length>=limit)break; const item=pool[round]; if(!item||seen.has(item.url))continue; seen.add(item.url); all.push(item); } round++; }\n      console.log(`[Threads benchmark batch] scanned=${scannedAccounts}/${maxAccounts} pools=${successfulPools} collected=${all.length}/${limit} challenged=${challengeCount}`);\n      if(!all.length && challengeCount>=Math.max(4,Math.ceil(scannedAccounts*0.5))){ console.error(`[Threads][CIRCUIT OPEN] challenged=${challengeCount}/${scannedAccounts} · profile scan stopped to protect collector session`); break; }\n    }\n    console.log(`[Threads benchmark] accounts=${scannedAccounts} pools=${successfulPools} collected=${all.length} requested=${limit}`);\n    return all.slice(0,limit);";
    if (!source.includes(oldCollector)) throw new Error('[ACCOUNT MATERIAL] benchmark collector marker not found');
    source = source.replace(oldCollector, resilientCollector);

    const browserMarker = "  const context = await browser.newContext({\n    locale:'ko-KR',\n    viewport:{width:1100,height:1500},\n    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'\n  });\n  return { browser, context };";
    const browserReplacement = [
      "  const __threadsFs=require('fs');",
      "  const __threadsPath=require('path');",
      "  const statePath=process.env.THREADS_STORAGE_STATE_PATH||'/app/db/threads-storage-state.json';",
      "  let storageState=null;",
      "  try {",
      "    if (__threadsFs.existsSync(statePath)) storageState=JSON.parse(__threadsFs.readFileSync(statePath,'utf8'));",
      "    else if (process.env.THREADS_STORAGE_STATE_JSON) { storageState=JSON.parse(process.env.THREADS_STORAGE_STATE_JSON); __threadsFs.mkdirSync(__threadsPath.dirname(statePath),{recursive:true}); __threadsFs.writeFileSync(statePath,JSON.stringify(storageState),{mode:0o600}); }",
      "  } catch(e) { console.error('[Threads][SESSION] storageState load failed:',e.message); storageState=null; }",
      "  const context = await browser.newContext({ locale:'ko-KR', viewport:{width:1100,height:1500}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', ...(storageState?{storageState}:{}) });",
      "  context.__threadsStatePath=statePath; context.__threadsStateHealthy=false;",
      "  const originalClose=context.close.bind(context);",
      "  context.close=async()=>{",
      "    if(context.__threadsStateHealthy){ try { __threadsFs.mkdirSync(__threadsPath.dirname(statePath),{recursive:true}); await context.storageState({path:statePath}); try{__threadsFs.chmodSync(statePath,0o600);}catch{} console.log('[Threads][SESSION] healthy state persisted'); } catch(e){ console.error('[Threads][SESSION] storageState save failed:',e.message); } }",
      "    else console.warn('[Threads][SESSION] challenged/unverified context · existing persistent state preserved');",
      "    return originalClose();",
      "  };",
      "  console.log(`[Threads][SESSION] collector session=${storageState?'RESTORED':'ANONYMOUS'} path=${statePath}`);",
      "  return { browser, context };"
    ].join('\n');
    if (!source.includes(browserMarker)) throw new Error('[ACCOUNT MATERIAL] Threads browser session marker not found');
    source = source.replace(browserMarker, browserReplacement);

    const evalStart = "    return await page.evaluate(({username,limit}) => {";
    const evalStartReplacement = [
      "    const __profileDiag=await page.evaluate(()=>({ finalUrl:location.href, title:String(document.title||'').slice(0,160), anchors:document.querySelectorAll('a').length, postLinks:document.querySelectorAll('a[href*=\"/post/\"]').length, articles:document.querySelectorAll('article,[role=\"article\"]').length, hrefSamples:[...document.querySelectorAll('a[href]')].map(a=>{try{return new URL(a.href,location.origin).pathname}catch{return ''}}).filter(Boolean).slice(0,12), bodyText:String(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,220) }));",
      "    const __profileResult=await page.evaluate(({username,limit}) => {"
    ].join('\n');
    const evalEnd = "    }, {username,limit});\n  } finally { try{await page.close();}catch{} }";
    const evalEndReplacement = [
      "    }, {username,limit});",
      "    const __login=/\\/login\\//i.test(__profileDiag.finalUrl)||/Threads\\s*[•·]\\s*로그인/i.test(__profileDiag.title);",
      "    const __errorShell=/문제가 발생했습니다|나중에 다시 시도/i.test(__profileDiag.bodyText);",
      "    const __challenged=__login||__errorShell;",
      "    if(__profileResult.length&&!__challenged) context.__threadsStateHealthy=true;",
      "    if(__challenged) Object.defineProperty(__profileResult,'__threadsChallenge',{value:true,enumerable:false});",
      "    const __diagMsg=`@${username} final=${__profileDiag.finalUrl} title=${JSON.stringify(__profileDiag.title)} postLinks=${__profileDiag.postLinks} anchors=${__profileDiag.anchors} articles=${__profileDiag.articles} hrefs=${JSON.stringify(__profileDiag.hrefSamples)} body=${JSON.stringify(__profileDiag.bodyText)}`;",
      "    if(__profileResult.length&&!__challenged) console.log(`[Threads][PROFILE OK] ${__diagMsg} posts=${__profileResult.length}`); else console.error(`[Threads][PROFILE ${__challenged?'CHALLENGED':'EMPTY'}] ${__diagMsg}`);",
      "    return __profileResult;",
      "  } finally { try{await page.close();}catch{} }"
    ].join('\n');
    if (!source.includes(evalStart) || !source.includes(evalEnd)) throw new Error('[ACCOUNT MATERIAL] Threads profile diagnostic markers not found');
    source = source.replace(evalStart, evalStartReplacement).replace(evalEnd, evalEndReplacement);

    console.log('[Autopilot][ACCOUNT MATERIAL] DB 사용이력 필터 OFF · markUsedPost=NOOP · isUsedPost=false');
    console.log('[Threads][SESSION] persistent collector storageState support armed · challenged state overwrite blocked');
    console.log('[Threads][COLLECTOR] adaptive SaaS benchmark scan + challenge circuit breaker armed');
    console.log('[Threads][COLLECTOR DIAG] effective worker diagnostics armed');
    mod._compile(source, filename);
  };
}
