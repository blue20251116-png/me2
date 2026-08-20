const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');
  let removed = 0;

  // 소재 수집량과 실제 상세 후보를 줄여 Threads 직접 접근량을 낮춘다.
  source = source.replace(/collectBenchmarkMaterials\(\{limit:60\}\)/g, 'collectBenchmarkMaterials({limit:10})');
  source = source.replace(/async function collectQualifiedThreadsMaterials\(maxQualified=6\)/g, 'async function collectQualifiedThreadsMaterials(maxQualified=3)');
  source = source.replace(/for\(const candidate of candidates\.slice\(0,60\)\)/g, 'for(const candidate of candidates.slice(0,10))');
  source = source.replace(/collectQualifiedThreadsMaterials\(6\)/g, 'collectQualifiedThreadsMaterials(3)');

  // 작성자 댓글 쇼핑링크는 선택사항으로 유지한다.
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

  // confidence가 0~1 또는 0~100 어느 형식으로 와도 0~1로 환산한다.
  source = source.replace(
    /function purchasableTerm\(term\)\{/,
    `function confidence01(v){const n=Number(v)||0;return n>1?Math.min(1,n/100):Math.max(0,n);}\nfunction productMatchOk(vision,product){const sold=clean(vision?.soldObject);const name=clean(product?.name);if(!sold||!name)return true;const stop=new Set(['도구','제품','상품','아이템','용품','만들기','재료','요리']);const tokens=sold.split(/\\s+/).map(normalized).filter(x=>x.length>=2&&!stop.has(x));const n=normalized(name);if(tokens.length&&tokens.some(t=>n.includes(t)))return true;const soldFood=/(떡볶이|김밥|라면|롤케이크|빵|케이크|수육|고기|한우|치킨|닭|커피|무스|오이무침)/i.test(sold);const productAddon=/(소스|양념|분말|가루|시즈닝|믹스|띠지|포장|용기)/i.test(name);if(soldFood&&productAddon&&!/(소스|양념|분말|가루|시즈닝|믹스)/i.test(sold))return false;return tokens.length===0;}\nfunction purchasableTerm(term){`
  );

  // 영상이 있다고 수집 단계에서 확인했지만 실제 playable URL을 못 얻은 소재는 이미지로 강등하지 않는다.
  source = source.replace(
    /console\.log\(`\[AutopilotV3\]\[TRY\] \$\{idx\+1\}\/\$\{materials\.length\} @\$\{material\.username\|\|'-'\} source=\$\{material\.url\}`\);/,
    `console.log(\`[AutopilotV3][TRY] \${idx+1}/\${materials.length} @\${material.username||'-'} source=\${material.url}\`);\n      const sourceClaimsVideo=!!material.hasVideo||Number(material.videoCount||0)>0;\n      const playableVideos=Array.isArray(material.videos)?material.videos.filter(Boolean):[];\n      if(sourceClaimsVideo&&!playableVideos.length){\n        lastError=new Error('원본 영상 존재 확인됨 · 현재 영상 URL 추출 실패');\n        console.log(\`[AutopilotV3][VIDEO QUALITY SKIP] @\${material.username||'-'} hasVideo=yes playable=0 → 이미지 강등 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }`
  );

  // 판매 대상 신뢰도가 0.5 미만이면 쿠팡 검색/CONTENT MIX fallback까지 진행하지 않는다.
  source = source.replace(
    /const vision=await identifyCommerceTarget\(accountId,material\);\n      const analysis=await analyzeMaterial\(accountId,material,target,vision\);/,
    `const vision=await identifyCommerceTarget(accountId,material);\n      const conf=confidence01(vision?.confidence);\n      if(conf<0.5){\n        lastError=new Error(\`판매 대상 신뢰도 부족 confidence=\${vision?.confidence??0}\`);\n        console.log(\`[AutopilotV3][CONFIDENCE SKIP] @\${material.username||'-'} confidence=\${vision?.confidence??0} normalized=\${conf.toFixed(2)} → 상품 연결 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }\n      const analysis=await analyzeMaterial(accountId,material,target,vision);`
  );

  // 검색 결과가 원본 판매대상과 맞지 않으면 그대로 발행하지 않는다.
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
  const videoGate = source.includes('[AutopilotV3][VIDEO QUALITY SKIP]');
  const productGate = source.includes('[AutopilotV3][PRODUCT MATCH SKIP]');
  console.log(`[Autopilot][MATERIAL SAFETY] pool10=${pool10?'ON':'FAIL'} candidates3=${candidates3?'ON':'FAIL'} confidence>=0.5=${confidenceGate?'ON':'FAIL'} video-downgrade-block=${videoGate?'ON':'FAIL'} product-match=${productGate?'ON':'FAIL'}`);

  mod._compile(source, filename);
};

console.log('[Autopilot][NO-LINK-FILTER] 10개 수집 + 후보 3개 + 저신뢰/영상강등/상품매칭 안전장치 활성화');
