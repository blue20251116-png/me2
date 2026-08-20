const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');
  let removed = 0;

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
    `function confidence01(v){const n=Number(v)||0;return n>1?Math.min(1,n/100):Math.max(0,n);}\nfunction purchasableTerm(term){`
  );

  // 영상이 있다고 수집 단계에서 확인했지만 실제 playable URL을 못 얻은 소재는 이미지로 강등하지 않는다.
  // 429/cooldown 때문에 영상 추출이 실패한 경우 다음 소재로 넘긴다.
  source = source.replace(
    /console\.log\(`\[AutopilotV3\]\[TRY\] \$\{idx\+1\}\/\$\{materials\.length\} @\$\{material\.username\|\|'-'\} source=\$\{material\.url\}`\);/,
    `console.log(\`[AutopilotV3][TRY] \${idx+1}/\${materials.length} @\${material.username||'-'} source=\${material.url}\`);\n      const sourceClaimsVideo=!!material.hasVideo||Number(material.videoCount||0)>0;\n      const playableVideos=Array.isArray(material.videos)?material.videos.filter(Boolean):[];\n      if(sourceClaimsVideo&&!playableVideos.length){\n        lastError=new Error('원본 영상 존재 확인됨 · 현재 영상 URL 추출 실패');\n        console.log(\`[AutopilotV3][VIDEO QUALITY SKIP] @\${material.username||'-'} hasVideo=yes playable=0 → 이미지 강등 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }`
  );

  // 판매 대상 신뢰도가 0.5 미만이면 쿠팡 검색/CONTENT MIX fallback까지 진행하지 않는다.
  source = source.replace(
    /const vision=await identifyCommerceTarget\(accountId,material\);\n      const analysis=await analyzeMaterial\(accountId,material,target,vision\);/,
    `const vision=await identifyCommerceTarget(accountId,material);\n      const conf=confidence01(vision?.confidence);\n      if(conf<0.5){\n        lastError=new Error(\`판매 대상 신뢰도 부족 confidence=\${vision?.confidence??0}\`);\n        console.log(\`[AutopilotV3][CONFIDENCE SKIP] @\${material.username||'-'} confidence=\${vision?.confidence??0} normalized=\${conf.toFixed(2)} → 상품 연결 금지 · 다음 소재\`);\n        markUsedPost(material.url);\n        continue;\n      }\n      const analysis=await analyzeMaterial(accountId,material,target,vision);`
  );

  // 결과에도 원본 영상 존재 신호를 남겨 후속 패치가 이미지 대체를 하지 않도록 한다.
  source = source.replace(
    /referenceImage:material\.images\?\.\[0\]\|\|null,visionTarget:vision\}/,
    `referenceImage:material.images?.[0]||null,sourceHasVideo:!!material.hasVideo||Number(material.videoCount||0)>0,visionTarget:vision}`
  );

  if (!removed) {
    console.warn('[Autopilot][MATERIAL SAFETY] 경고: 링크 필수조건 패턴을 찾지 못함');
  } else {
    console.log(`[Autopilot][NO-LINK-FILTER] 링크 필수조건 제거 count=${removed}`);
  }

  const confidenceGate = source.includes('[AutopilotV3][CONFIDENCE SKIP]');
  const videoGate = source.includes('[AutopilotV3][VIDEO QUALITY SKIP]');
  console.log(`[Autopilot][MATERIAL SAFETY] confidence>=0.5=${confidenceGate?'ON':'FAIL'} video-downgrade-block=${videoGate?'ON':'FAIL'}`);

  mod._compile(source, filename);
};

console.log('[Autopilot][NO-LINK-FILTER] 링크 선택사항 + 저신뢰/영상강등 안전장치 활성화');
