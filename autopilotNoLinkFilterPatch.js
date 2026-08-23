const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');
  let removed = 0;

  source = source.replace(/collectBenchmarkMaterials\(\{limit:60\}\)/g, 'collectBenchmarkMaterials({limit:10})');
  source = source.replace(/async function collectQualifiedThreadsMaterials\(maxQualified=6\)/g, 'async function collectQualifiedThreadsMaterials(maxQualified=3)');
  source = source.replace(/for\(const candidate of candidates\.slice\(0,60\)\)/g, 'for(const candidate of candidates.slice(0,10))');
  source = source.replace(/collectQualifiedThreadsMaterials\(6\)/g, 'collectQualifiedThreadsMaterials(3)');

  const patterns = [
    /if\s*\(\s*!hasAffiliateLink\(authorReplies\)\s*\)\s*throw new Error\(['"]작성자 댓글에 쿠팡\/네이버 쇼핑 링크가 없는 소재['"]\)\s*;?/g,
    /if\s*\(\s*!hasAffiliateLink\(authorReplies\)\s*\)\s*\{\s*throw new Error\(['"]작성자 댓글에 쿠팡\/네이버 쇼핑 링크가 없는 소재['"]\)\s*;?\s*\}/g,
  ];
  for (const re of patterns) {
    source = source.replace(re, () => {
      removed += 1;
      return '/* NO-LINK-FILTER: affiliate reply link is optional */';
    });
  }

  source = source.replace(/쇼핑링크 확인 source=\$\{material\.url\}/g, '소재 후보채택 source=${material.url}');
  source = source.replace(
    /작성자 댓글에 쇼핑 링크가 있다는 점을 고려해 무엇을 판매하는 글인지 최대한 구체적으로 추론하되 근거 없는 브랜드\/모델은 만들지 않는다\./g,
    '본문·작성자 댓글·이미지/영상에서 실제 구매 가능한 대상을 최대한 구체적으로 추론하되 근거 없는 브랜드/모델은 만들지 않는다. 작성자 댓글에 쇼핑 링크가 없어도 정상 소재로 처리한다.'
  );

  // OpenAI가 confidence를 0, 0~1, 0~100 등 제각각 반환해도 안전하게 0~100으로 통일한다.
  source = source.replace(
    /searchTerms는 쿠팡에서 실제 상품을 찾기 좋은 검색어 최대 2개다\. 단순 주제어\(예: 운동, 다이어트, 일상\)만 쓰지 말고 실제 구매 가능한 물건\/식품명이어야 한다\. JSON만 출력:/,
    'searchTerms는 쿠팡에서 실제 상품을 찾기 좋은 검색어 최대 2개다. 단순 주제어(예: 운동, 다이어트, 일상)만 쓰지 말고 실제 구매 가능한 물건/식품명이어야 한다. confidence는 반드시 0~100 사이 정수로 쓰고, 판매 대상이 본문·작성자 댓글·이미지 중 둘 이상의 근거로 명확하면 70 이상을 준다. JSON만 출력:'
  );
  source = source.replace(
    "confidence:Math.max(0,Math.min(100,Number(d?.confidence)||0)),evidence:clean(d?.evidence).slice(0,300)",
    "confidence:(()=>{let n=Number(d?.confidence);if(Number.isFinite(n)&&n>0&&n<=1)n*=100;if(!Number.isFinite(n)||n<0)n=0;n=Math.min(100,n);if(n===0){const sold=clean(d?.soldObject),dish=clean(d?.dish),ingredient=clean(d?.promotedIngredient),terms=(Array.isArray(d?.searchTerms)?d.searchTerms:[]).map(clean).filter(Boolean);if(sold&&terms.length)n=75;else if(dish&&ingredient&&terms.length)n=70;else if((sold||dish)&&terms.length)n=60;}return n;})(),evidence:clean(d?.evidence).slice(0,300)"
  );

  const visionHelper = [
    'async function prepareVisionImageUrls(imageUrls){',
    '  const out=[];',
    '  for(const raw of (imageUrls||[]).filter(Boolean).slice(0,2)){',
    '    try{',
    "      if(/^data:image\\//i.test(String(raw))){out.push(raw);continue;}",
    "      const r=await axios.get(String(raw),{responseType:'arraybuffer',timeout:15000,maxRedirects:5,maxContentLength:12*1024*1024,maxBodyLength:12*1024*1024,headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',referer:'https://www.threads.com/',accept:'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},validateStatus:s=>s>=200&&s<400});",
    "      const type=String(r.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();",
    '      const body=Buffer.from(r.data||[]);',
    "      if(!type.startsWith('image/')||body.length<512)throw new Error('invalid image response');",
    "      out.push('data:'+type+';base64,'+body.toString('base64'));",
    "      console.log('[AutopilotV3][VISION CACHE] source='+new URL(String(raw)).hostname+' bytes='+body.length);",
    "    }catch(e){console.warn('[AutopilotV3][VISION CACHE] 이미지 로컬화 실패: '+(e.response?.status||'-')+' '+e.message);}",
    '  }',
    '  return out;',
    '}',
    'async function callOpenAIVision(accountId,system,text,imageUrls,{maxTokens=1400,temperature=.15}={}){'
  ].join('\n');

  source = source.replace(
    /async function callOpenAIVision\(accountId,system,text,imageUrls,\{maxTokens=1400,temperature=\.15\}=\{\}\)\{/,
    visionHelper
  );

  source = source.replace(
    /const content=\[\{type:'text',text\}\];\n  for\(const url of \(imageUrls\|\|\[\]\)\.filter\(Boolean\)\.slice\(0,3\)\)content\.push\(\{type:'image_url',image_url:\{url\}\}\);/,
    "const content=[{type:'text',text}];\n  const safeImageUrls=await prepareVisionImageUrls(imageUrls);\n  if(!safeImageUrls.length)throw new Error('VISION_IMAGE_CACHE_EMPTY');\n  for(const url of safeImageUrls)content.push({type:'image_url',image_url:{url}});"
  );

  const commerceHelpers = [
    "function confidence01(v){const n=Number(v)||0;return n>1?Math.min(1,n/100):Math.max(0,n);}",
    "function sameCommerceCategory(a,b){const x=normalized(a),y=normalized(b);if(!x||!y)return false;const groups=[['올리브오일','올리브유','엑스트라버진올리브오일','압착올리브유'],['입욕제','배쓰밤','배스밤','바스밤','목욕입욕제','온천입욕제'],['니플패드','니플밴드','유두패드','유두밴드'],['얼룩제거제','부분세제','스팟리무버','얼룩제거펜'],['의류복원제','세탁복원제','옷복원제']];return groups.some(g=>g.some(v=>x.includes(normalized(v)))&&g.some(v=>y.includes(normalized(v))));}",
    "function productMatchOk(vision,product){const sold=clean(vision?.soldObject);const name=clean(product?.name);if(!sold||!name)return true;if(sameCommerceCategory(sold,name))return true;const stop=new Set(['도구','제품','상품','아이템','용품','만들기','재료','요리']);const tokens=sold.split(/\\s+/).map(normalized).filter(x=>x.length>=2&&!stop.has(x));const n=normalized(name);if(tokens.length&&tokens.some(t=>n.includes(t)))return true;const soldFood=/(떡볶이|김밥|라면|롤케이크|빵|케이크|수육|고기|한우|치킨|닭|커피|무스|오이무침)/i.test(sold);const productAddon=/(소스|양념|분말|가루|시즈닝|믹스|띠지|포장|용기)/i.test(name);if(soldFood&&productAddon&&!/(소스|양념|분말|가루|시즈닝|믹스)/i.test(sold))return false;return tokens.length===0;}",
    "function buildSoldFirstTermsBase(analysis,vision){const sold=clean(vision?.soldObject||analysis?.topic||'');const original=[...(analysis?.searchTerms||[])].map(clean).filter(Boolean);const out=[];const push=v=>{v=clean(v);if(v&&!out.includes(v))out.push(v);};if(sold)push(sold);for(const t of original){if(out.length>=2)break;const ns=normalized(sold),nt=normalized(t);if(!sold||nt.includes(ns)||ns.includes(nt)||sameCommerceCategory(sold,t)){push(t);continue;}const soldTokens=sold.split(/\\s+/).map(normalized).filter(x=>x.length>=2);if(soldTokens.some(tok=>nt.includes(tok)))push(t);}if(out.length<2&&sold){const tokens=sold.split(/\\s+/).filter(Boolean);if(tokens.length>1)push(tokens.slice(-2).join(' '));}return out.slice(0,2);}",
    "const COUNTRY_IDENTITY_HINTS=['일본','중국','미국','독일','프랑스','이탈리아','영국','스페인','스위스','호주','뉴질랜드','태국','베트남','대만','홍콩','캐나다','터키','인도','인도네시아','말레이시아','싱가포르'];",
    "function countryIdentityHints(values){const joined=' '+(values||[]).map(clean).filter(Boolean).join(' ')+' ';return COUNTRY_IDENTITY_HINTS.filter(x=>joined.includes(x));}",
    "function requiredCountriesFor(analysis,vision){return countryIdentityHints([clean(vision?.soldObject),...((vision?.searchTerms)||[]).map(clean),...((analysis?.searchTerms)||[]).map(clean),clean(analysis?.topic),clean(vision?.evidence)]);}",
    "function nameHasCountries(name,countries){const n=normalized(name);return (countries||[]).every(c=>n.includes(normalized(c)));}",
    // 국가 단서가 없으면 기존 base 결과를 그대로 반환한다(수정 전과 바이트 단위 동일).
    // 국가 단서가 있을 때만 최소 하나의 검색어에 국가명을 강제로 남긴다.
    "function buildSoldFirstTerms(analysis,vision){const base=buildSoldFirstTermsBase(analysis,vision);const req=requiredCountriesFor(analysis,vision);if(!req.length)return base;if(base.some(t=>nameHasCountries(t,req)))return base;const lead=clean(req.join(' ')+' '+(base[0]||clean(vision?.soldObject||analysis?.topic||'')));const out=[lead];for(const t of base){if(out.length>=2)break;if(!out.includes(t))out.push(t);}console.log(`[AutopilotV3][COUPANG COUNTRY IDENTITY] required=${req.join('/')} terms=${out.join(' / ')}`);return out.slice(0,2);}",
    "function identityTokens(text){const s=clean(String(text||'').replace(/https?:\\/\\/\\S+/gi,' '));return s.split(/[\\s,\\/·\\-_()\\[\\]{}]+/).map(x=>clean(x)).filter(Boolean).filter(x=>!/^[0-9]+(?:[.][0-9]+)?(?:개입|개|입|팩|박스|매|장|병|캔|포|봉|g|kg|ml|l|리터|호|인치|cm|mm)?$/i.test(x)).filter(x=>!COUNTRY_IDENTITY_HINTS.includes(x)).filter(x=>{const n=normalized(x);return /^[a-z]+$/.test(n)?n.length>=3:n.length>=2;});}",
    "function isLatinToken(t){return /^[a-z]+$/.test(normalized(t));}",
    "function strongCandidateToken(t,sold){const n=normalized(t);if(!n)return false;if(isLatinToken(t))return true;const ns=normalized(sold);if(!ns)return true;return !ns.includes(n)&&!n.includes(ns);}",
    "function extractStrongIdentity(material,vision,analysis){const replies=clean(material?.authorReplies);if(!replies)return[];const sold=clean(vision?.soldObject||analysis?.topic||'');const inReplies=new Set(identityTokens(replies).map(normalized));if(!inReplies.size)return[];const evidence=identityTokens([...((vision?.searchTerms)||[]),...((analysis?.searchTerms)||[]),clean(analysis?.secretTerm),clean(vision?.soldObject)].join(' '));const strong=[];for(const t of evidence){const n=normalized(t);if(!inReplies.has(n))continue;if(!strongCandidateToken(t,sold))continue;if(!strong.some(x=>normalized(x)===n))strong.push(t);}return strong.slice(0,4);}",
    "const VARIANT_IDENTITY_TOKEN=/^(미니|대용량|소용량|리필|세트|묶음|정품|신상|기획|한정|스페셜|라지|스몰|빅|점보|낱개|증정)$/;",
    "function isVariantToken(t){return VARIANT_IDENTITY_TOKEN.test(clean(t));}",
    "function coreStrongTokens(strong){return (strong||[]).filter(t=>!isVariantToken(t));}",
    "function nameHasStrongIdentity(name,strong,sold){if(!strong||!strong.length)return true;if(sameCommerceCategory(sold,name))return true;const core=coreStrongTokens(strong);if(!core.length)return true;const n=normalized(name);return core.every(t=>n.includes(normalized(t)));}",
    'function purchasableTerm(term){'
  ].join('\n');

  source = source.replace(/function purchasableTerm\(term\)\{/, commerceHelpers);

  source = source.replace(
    /const p=await coupangApi\.searchProducts\(accountId,term,8\);if\(!p\.length\)continue;/,
    "let p;try{p=await coupangApi.searchProducts(accountId,term,8);}catch(e){const status=Number(e?.response?.status||0);if(status===401)console.error('[Coupang][401] stage=search account='+accountId+' term=\"'+term+'\" message=\"'+(e?.response?.data?.message||e.message)+'\"');throw e;}if(!p.length)continue;"
  );

  source = source.replace(
    /console\.log\(`\[AutopilotV3\]\[TRY\] \$\{idx\+1\}\/\$\{materials\.length\} @\$\{material\.username\|\|'-'\} source=\$\{material\.url\}`\);/,
    `console.log(\`[AutopilotV3][TRY] \${idx+1}/\${materials.length} @\${material.username||'-'} source=\${material.url}\`);\n      const sourceClaimsVideo=!!material.hasVideo||Number(material.videoCount||0)>0;\n      const playableVideos=Array.isArray(material.videos)?material.videos.filter(Boolean):[];\n      if(sourceClaimsVideo&&!playableVideos.length){\n        lastError=new Error('원본 영상 존재 확인됨 · 현재 영상 URL 추출 실패');\n        console.log(\`[AutopilotV3][VIDEO QUALITY SKIP] @\${material.username||'-'} hasVideo=yes playable=0 → 이미지 강등 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }`
  );

  source = source.replace(
    /const vision=await identifyCommerceTarget\(accountId,material\);\n      const analysis=await analyzeMaterial\(accountId,material,target,vision\);/,
    `const vision=await identifyCommerceTarget(accountId,material);\n      const conf=confidence01(vision?.confidence);\n      if(conf<0.5){\n        lastError=new Error(\`판매 대상 신뢰도 부족 confidence=\${vision?.confidence??0}\`);\n        console.log(\`[AutopilotV3][CONFIDENCE SKIP] @\${material.username||'-'} confidence=\${vision?.confidence??0} normalized=\${conf.toFixed(2)} → 상품 연결 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }\n      const analysis=await analyzeMaterial(accountId,material,target,vision);`
  );

  source = source.replace(
    "async function findProduct(accountId,terms){",
    "async function findProduct(accountId,terms,strongIdentity,soldObject){"
  );

  // 국가 identity strict 검증: 검색어에 국가 단서가 있을 때만 후보 상품명을 재확인한다.
  // 국가 단서가 없으면 기존 `exact||p[0]` 동작을 그대로 유지한다.
  source = source.replace(
    "    const exact=p.find(x=>{const n=normalized(x.name);return tokens.length&&tokens.every(t=>n.includes(t));});\n    return{product:exact||p[0],searchTerm:term};",
    "    const exact=p.find(x=>{const n=normalized(x.name);return tokens.length&&tokens.every(t=>n.includes(t));});\n    const reqCountries=countryIdentityHints([term]);\n    const strong=Array.isArray(strongIdentity)?strongIdentity:[];\n    if(!reqCountries.length&&!strong.length)return{product:exact||p[0],searchTerm:term};\n    const okCandidate=x=>nameHasCountries(x?.name,reqCountries)&&nameHasStrongIdentity(x?.name,strong,soldObject);\n    if(exact&&okCandidate(exact)){console.log(`[AutopilotV3][COUPANG EXACT IDENTITY] country=${reqCountries.join('/')||'-'} strong=${strong.join('/')||'-'} candidate=\"${clean(exact.name)}\" result=PASS`);return{product:exact,searchTerm:term};}\n    const alt=p.find(okCandidate);\n    if(alt){console.log(`[AutopilotV3][COUPANG EXACT IDENTITY] country=${reqCountries.join('/')||'-'} strong=${strong.join('/')||'-'} candidate=\"${clean(alt.name)}\" result=PASS`);return{product:alt,searchTerm:term};}\n    console.warn(`[AutopilotV3][COUPANG EXACT IDENTITY] country=${reqCountries.join('/')||'-'} strong=${strong.join('/')||'-'} candidates=${p.length} result=REJECT → 다음 검색어`);\n    continue;"
  );

  source = source.replace(
    /console\.log\(`\[AutopilotV3\]\[COUPANG SEARCH\] 최종 검색어=\$\{analysis\.searchTerms\.join\(' \/ '\)\} \(최대 2회\)`\);\n      const found=await findProduct\(accountId,analysis\.searchTerms\);/,
    `analysis.searchTerms=buildSoldFirstTerms(analysis,vision);\n      console.log(\`[AutopilotV3][COUPANG SEARCH][SOLD-FIRST] sold=\"\${vision?.soldObject||'-'}\" 최종 검색어=\${analysis.searchTerms.join(' / ')} (최대 2회)\`);\n      const __strong=extractStrongIdentity(material,vision,analysis);\n      if(__strong.length)console.log(\`[AutopilotV3][EXACT PRODUCT IDENTITY] @\${material.username||'-'} strong=\${__strong.join(' / ')}\`);\n      const found=await findProduct(accountId,analysis.searchTerms,__strong,vision?.soldObject||analysis?.topic||'');`
  );

  source = source.replace(
    /if\(!found\.product\)\{([\s\S]*?)continue;\n      \}\n      const generated=/,
    `if(!found.product){$1continue;\n      }\n      if(!productMatchOk(vision,found.product)){\n        lastError=new Error(\`쿠팡 상품 매칭 불일치 sold=\"\${vision?.soldObject||'-'}\" product=\"\${found.product.name||'-'}\"\`);\n        console.log(\`[AutopilotV3][PRODUCT MATCH SKIP] @\${material.username||'-'} sold=\"\${vision?.soldObject||'-'}\" product=\"\${found.product.name||'-'}\" → 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }\n      const generated=`
  );

  source = source.replace(
    /referenceImage:material\.images\?\.\[0\]\|\|null,visionTarget:vision\}/,
    `referenceImage:material.images?.[0]||null,sourceHasVideo:!!material.hasVideo||Number(material.videoCount||0)>0,visionTarget:vision}`
  );

  if (!removed) console.warn('[Autopilot][MATERIAL SAFETY] 경고: 링크 필수조건 패턴을 찾지 못함');
  else console.log(`[Autopilot][NO-LINK-FILTER] 링크 필수조건 제거 count=${removed}`);

  const pool10 = source.includes('collectBenchmarkMaterials({limit:10})');
  const candidates3 = source.includes('collectQualifiedThreadsMaterials(3)');
  const confidenceGate = source.includes('[AutopilotV3][CONFIDENCE SKIP]');
  const confidenceNormalize = source.includes('confidence는 반드시 0~100 사이 정수');
  const videoGate = source.includes('[AutopilotV3][VIDEO QUALITY SKIP]');
  const productGate = source.includes('[AutopilotV3][PRODUCT MATCH SKIP]');
  const visionCache = source.includes('[AutopilotV3][VISION CACHE]');
  const soldFirst = source.includes('[AutopilotV3][COUPANG SEARCH][SOLD-FIRST]');
  const coupang401 = source.includes('[Coupang][401] stage=search');
  const countryIdentity = source.includes('[AutopilotV3][COUPANG EXACT IDENTITY]') && source.includes('nameHasCountries(x?.name,reqCountries)');
  const exactIdentity = source.includes('function extractStrongIdentity(') && source.includes('__strong,vision?.soldObject');
  console.log(`[Autopilot][MATERIAL SAFETY] pool10=${pool10?'ON':'FAIL'} candidates3=${candidates3?'ON':'FAIL'} confidence>=0.5=${confidenceGate?'ON':'FAIL'} confidence-normalize=${confidenceNormalize?'ON':'FAIL'} video-downgrade-block=${videoGate?'ON':'FAIL'} product-match=${productGate?'ON':'FAIL'} vision-cache=${visionCache?'ON':'FAIL'} sold-first=${soldFirst?'ON':'FAIL'} coupang401-log=${coupang401?'ON':'FAIL'} country-identity=${countryIdentity?'ON':'FAIL'} exact-identity=${exactIdentity?'ON':'FAIL'}`);

  mod._compile(source, filename);
};

console.log('[Autopilot][NO-LINK-FILTER] 10개 수집 + 후보 3개 + confidence 보정 + 저신뢰/영상강등/상품매칭 + Vision 로컬캐시 + sold 우선검색 활성화');