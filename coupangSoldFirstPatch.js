'use strict';

const Module = require('module');
const originalJsLoader = Module._extensions['.js'];
let patched = false;

function patchSource(src, filename) {
  if (patched || !filename.endsWith('/autopilotMaterialEngine.js')) return src;
  patched = true;

  const findProductMarker = "async function findProduct(accountId,terms){\n  for(const term of(terms||[]).slice(0,2)){\n    const p=await coupangApi.searchProducts(accountId,term,8);if(!p.length)continue;";
  if (!src.includes(findProductMarker)) {
    console.warn('[Autopilot][COUPANG SOLD-FIRST] findProduct marker not found');
    return src;
  }

  const helper = `function buildSoldFirstTerms(analysis,vision){\n  const sold=clean(vision?.soldObject||analysis?.topic||'');\n  const original=[...(analysis?.searchTerms||[])].map(clean).filter(Boolean);\n  const out=[];\n  const push=v=>{v=clean(v);if(v&&!out.includes(v))out.push(v);};\n  if(sold)push(sold);\n  for(const t of original){\n    if(out.length>=2)break;\n    const nt=normalized(t),ns=normalized(sold);\n    if(!sold||nt.includes(ns)||ns.includes(nt)){push(t);continue;}\n    const soldTokens=clean(sold).split(/\\s+/).map(normalized).filter(x=>x.length>=2);\n    const termNorm=normalized(t);\n    if(soldTokens.some(tok=>termNorm.includes(tok)))push(t);\n  }\n  if(out.length<2&&sold){\n    const tokens=clean(sold).split(/\\s+/).filter(Boolean);\n    if(tokens.length>1)push(tokens.slice(-2).join(' '));\n  }\n  return out.slice(0,2);\n}\n\n`;

  src = src.replace('async function findProduct(accountId,terms){', helper + 'async function findProduct(accountId,terms){');

  src = src.replace(
    "    const p=await coupangApi.searchProducts(accountId,term,8);if(!p.length)continue;",
    "    let p;try{p=await coupangApi.searchProducts(accountId,term,8);}catch(e){const status=Number(e?.response?.status||0);if(status===401)console.error(`[Coupang][401] stage=search account=${accountId} term=\"${term}\" message=\"${e?.response?.data?.message||e.message}\"`);throw e;}if(!p.length)continue;"
  );

  const searchMarker = "      console.log(`[AutopilotV3][COUPANG SEARCH] 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);\n      const found=await findProduct(accountId,analysis.searchTerms);";
  if (src.includes(searchMarker)) {
    src = src.replace(
      searchMarker,
      "      analysis.searchTerms=buildSoldFirstTerms(analysis,vision);\n      console.log(`[AutopilotV3][COUPANG SEARCH][SOLD-FIRST] sold=\"${clean(vision?.soldObject||'-')}\" 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);\n      const found=await findProduct(accountId,analysis.searchTerms);"
    );
  } else {
    console.warn('[Autopilot][COUPANG SOLD-FIRST] search marker not found');
  }

  console.log('[Autopilot][COUPANG SOLD-FIRST] 판매대상 sold 우선 검색 + 동일 상품군 2차 검색 + 401 stage 진단 활성화');
  return src;
}

Module._extensions['.js'] = function patchedLoader(mod, filename) {
  const fs = require('fs');
  if (filename.endsWith('/autopilotMaterialEngine.js')) {
    const src = fs.readFileSync(filename, 'utf8');
    mod._compile(patchSource(src, filename), filename);
    return;
  }
  return originalJsLoader(mod, filename);
};
