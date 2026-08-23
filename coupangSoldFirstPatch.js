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

  const helper = `const SOLD_FIRST_COUNTRY_HINTS=['일본','중국','미국','독일','프랑스','이탈리아','영국','스페인','스위스','호주','뉴질랜드','태국','베트남','대만','홍콩','캐나다','터키','인도','인도네시아','말레이시아','싱가포르'];\nfunction soldFirstWords(v){return clean(v).split(/\\s+/).map(x=>x.trim()).filter(Boolean);}\nfunction soldFirstCountryHints(values){\n  const joined=' '+(values||[]).map(clean).filter(Boolean).join(' ')+' ';\n  return SOLD_FIRST_COUNTRY_HINTS.filter(x=>joined.includes(x));\n}\nfunction soldFirstMerge(sold,term,requiredHints){\n  const out=[];\n  const pushWord=w=>{w=clean(w);if(w&&!out.some(x=>normalized(x)===normalized(w)))out.push(w);};\n  for(const h of requiredHints||[])pushWord(h);\n  for(const w of soldFirstWords(sold))pushWord(w);\n  for(const w of soldFirstWords(term)){\n    if(out.length>=7)break;\n    pushWord(w);\n  }\n  return out.join(' ').trim();\n}\nfunction buildSoldFirstTerms(analysis,vision){\n  const sold=clean(vision?.soldObject||analysis?.topic||'');\n  const original=[...(vision?.searchTerms||[]),...(analysis?.searchTerms||[])].map(clean).filter(Boolean);\n  const requiredHints=soldFirstCountryHints([sold,...original,vision?.evidence]);\n  const out=[];\n  const push=v=>{v=clean(v);if(v&&!out.some(x=>normalized(x)===normalized(v)))out.push(v);};\n  const scored=original.map(t=>{\n    const hints=soldFirstCountryHints([t]);\n    const soldTokens=soldFirstWords(sold).map(normalized).filter(x=>x.length>=2);\n    const tn=normalized(t);\n    const overlap=soldTokens.filter(x=>tn.includes(x)).length;\n    return{t,score:hints.length*100+overlap*10+Math.min(t.length,30)};\n  }).sort((a,b)=>b.score-a.score);\n  if(requiredHints.length){\n    for(const row of scored){\n      push(soldFirstMerge(sold,row.t,requiredHints));\n      if(out.length>=2)break;\n    }\n    if(out.length<2)push(soldFirstMerge(sold,'',requiredHints));\n    return out.slice(0,2);\n  }\n  if(sold)push(sold);\n  for(const row of scored){\n    if(out.length>=2)break;\n    const merged=soldFirstMerge(sold,row.t,[]);\n    if(merged)push(merged);\n  }\n  if(!out.length)for(const t of original){push(t);if(out.length>=2)break;}\n  return out.slice(0,2);\n}\nfunction soldFirstCandidateMatch(term,productName){\n  const words=soldFirstWords(term).map(normalized).filter(x=>x.length>=2);\n  const name=normalized(productName);\n  if(!words.length||!name)return{ok:false,ratio:0,matched:[],missing:words};\n  const matched=words.filter(x=>name.includes(x));\n  const missing=words.filter(x=>!name.includes(x));\n  const countries=soldFirstCountryHints([term]);\n  const countryOk=countries.every(x=>name.includes(normalized(x)));\n  if(!countryOk)return{ok:false,ratio:matched.length/words.length,matched,missing,reason:'identity-country-mismatch'};\n  const ratio=matched.length/words.length;\n  const required=words.length===1?1:words.length===2?2:Math.ceil(words.length*0.67);\n  return{ok:matched.length>=required,ratio,matched,missing,reason:matched.length>=required?'token-match':'token-mismatch'};\n}\n\n`;

  src = src.replace('async function findProduct(accountId,terms){', helper + 'async function findProduct(accountId,terms){');

  src = src.replace(
    "    const p=await coupangApi.searchProducts(accountId,term,8);if(!p.length)continue;",
    "    let p;try{p=await coupangApi.searchProducts(accountId,term,8);}catch(e){const status=Number(e?.response?.status||0);if(status===401)console.error(`[Coupang][401] stage=search account=${accountId} term=\"${term}\" message=\"${e?.response?.data?.message||e.message}\"`);throw e;}if(!p.length)continue;"
  );

  const oldPick = "    const tokens=clean(term).split(/\\s+/).map(normalized).filter(x=>x.length>=2);\n    const exact=p.find(x=>{const n=normalized(x.name);return tokens.length&&tokens.every(t=>n.includes(t));});\n    return{product:exact||p[0],searchTerm:term};";
  const newPick = "    const tokens=clean(term).split(/\\s+/).map(normalized).filter(x=>x.length>=2);\n    const exact=p.find(x=>{const n=normalized(x.name);return tokens.length&&tokens.every(t=>n.includes(t));});\n    if(exact)return{product:exact,searchTerm:term};\n    const ranked=p.map(x=>({product:x,match:soldFirstCandidateMatch(term,x?.name)})).filter(x=>x.match.ok).sort((a,b)=>b.match.ratio-a.match.ratio);\n    if(ranked.length){const picked=ranked[0];console.log(`[AutopilotV3][COUPANG MATCH PASS] term=\"${term}\" product=\"${clean(picked.product?.name)}\" ratio=${picked.match.ratio.toFixed(2)}`);return{product:picked.product,searchTerm:term};}\n    console.warn(`[AutopilotV3][COUPANG MATCH REJECT] term=\"${term}\" candidates=${p.length} reason=identity-or-token-mismatch → 다음 검색어`);\n    continue;";
  if (src.includes(oldPick)) src = src.replace(oldPick, newPick);
  else console.warn('[Autopilot][COUPANG SOLD-FIRST] product pick marker not found');

  const searchMarker = "      console.log(`[AutopilotV3][COUPANG SEARCH] 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);\n      const found=await findProduct(accountId,analysis.searchTerms);";
  if (src.includes(searchMarker)) {
    src = src.replace(
      searchMarker,
      "      analysis.searchTerms=buildSoldFirstTerms(analysis,vision);\n      console.log(`[AutopilotV3][COUPANG SEARCH][SOLD-FIRST] sold=\"${clean(vision?.soldObject||'-')}\" 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);\n      const found=await findProduct(accountId,analysis.searchTerms);"
    );
  } else {
    console.warn('[Autopilot][COUPANG SOLD-FIRST] search marker not found');
  }

  console.log('[Autopilot][COUPANG SOLD-FIRST] v2 sold 정체성 보존 + 국가 단서 강제 + 후보 토큰 재검증 + 불일치 fail-closed');
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
