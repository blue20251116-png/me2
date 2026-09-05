'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

const previous = Module._extensions['.js'];
let applied = false;

Module._extensions['.js'] = function threadsCollectorDiagnosticLoader(mod, filename) {
  if (applied || !filename.endsWith(`${path.sep}benchmarkAccounts.js`)) {
    return previous(mod, filename);
  }
  applied = true;
  let source = fs.readFileSync(filename, 'utf8');

  const needle = "    return await page.evaluate(({username,limit}) => {";
  const replacement = [
    "    const __diagBefore=await page.evaluate(()=>({",
    "      finalUrl:location.href,",
    "      title:document.title||'',",
    "      postLinks:document.querySelectorAll('a[href*=\"/post/\"]').length,",
    "      anchors:document.querySelectorAll('a').length,",
    "      articles:document.querySelectorAll('article,[role=\"article\"]').length,",
    "      bodyText:String(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,220)",
    "    }));",
    "    const __result=await page.evaluate(({username,limit}) => {"
  ].join('\n');

  if (!source.includes(needle)) throw new Error('[Threads collector diag] profile evaluate marker not found');
  source = source.replace(needle, replacement);

  const endNeedle = "    }, {username,limit});\n  } finally { try{await page.close();}catch{} }";
  const endReplacement = [
    "    }, {username,limit});",
    "    if(!__result.length){",
    "      console.error(`[Threads][PROFILE EMPTY] @${username} final=${__diagBefore.finalUrl} title=${JSON.stringify(__diagBefore.title)} postLinks=${__diagBefore.postLinks} anchors=${__diagBefore.anchors} articles=${__diagBefore.articles} body=${JSON.stringify(__diagBefore.bodyText)}`);",
    "    } else {",
    "      console.log(`[Threads][PROFILE OK] @${username} posts=${__result.length} visiblePostLinks=${__diagBefore.postLinks}`);",
    "    }",
    "    return __result;",
    "  } finally { try{await page.close();}catch{} }"
  ].join('\n');
  if (!source.includes(endNeedle)) throw new Error('[Threads collector diag] profile evaluate end marker not found');
  source = source.replace(endNeedle, endReplacement);

  console.log('[Threads][COLLECTOR DIAG] empty-profile diagnostics armed');
  mod._compile(source, filename);
};
