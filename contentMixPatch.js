const fs=require('fs');
const path=require('path');

const target=path.resolve(path.join(__dirname,'autopilotMaterialEngine.js'));
const originalReadFileSync=fs.readFileSync.bind(fs);
let applied=false;

function transformSource(src){
  const cleanMarker="function clean(v){return String(v||'').replace(/\\s+/g,' ').trim();}";
  const cleanInsert=`${cleanMarker}\nfunction decodeEscapedNewlines(v){return String(v||'').replace(/\\\\r\\\\n/g,'\\n').replace(/\\\\n/g,'\\n').replace(/\\\\r/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}\nconst CONTENT_MODE_SEQUENCE=['product','recipe','lifestyle','product','lifestyle','recipe','product','lifestyle','recipe','lifestyle'];\nconst contentModeCursor=new Map();\nfunction preferredContentMode(accountId){const i=Number(contentModeCursor.get(accountId)||0)%CONTENT_MODE_SEQUENCE.length;return CONTENT_MODE_SEQUENCE[i];}\nfunction advanceContentMode(accountId){contentModeCursor.set(accountId,(Number(contentModeCursor.get(accountId)||0)+1)%CONTENT_MODE_SEQUENCE.length);}`;
  if(!src.includes(cleanMarker))throw new Error('[CONTENT MIX PATCH] clean marker not found');
  src=src.replace(cleanMarker,cleanInsert);

  const commonToneMarker=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 반응·상황·의외성·궁금증으로 시작한다.\n- ㅋㅋ는 자연스러울 때 최대 1~2회만. 억지 유행어 금지.\n- 확인되지 않은 구매/사용/섭취 경험을 만들어내지 않는다.`;
  const commonToneInsert=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 실제 Threads 사람이 쓰는 짧은 반응이나 생활 상황으로 시작한다.\n- '와 이거 대박이야ㅋㅋ', '이거 진짜 미쳤다ㅋㅋ', '아니 이거 뭐야ㅋㅋ', '와 이런 게 있었네ㅋㅋ' 같은 즉흥 반응형 시작을 적극 허용한다. 다만 같은 첫 문장을 연속 글에서 반복하지 않는다.\n- 본문은 반응/상황 → 실제 불편이나 궁금증 → 발견/제품 장면 → 기능 또는 결과 하나 → 짧은 반응 순서로 쓴다.\n- 한 줄에 한 생각만 쓰고 1~2줄마다 빈 줄을 둘 수 있다. 설명문처럼 문장을 붙이지 않는다.\n- ㅋㅋ는 자연스러울 때 0~2회 사용할 수 있다.\n- 광고 카피처럼 장점을 나열하지 말고 사람이 직접 피드에 쓴 것처럼 짧고 날것의 표현을 우선한다.\n- 확인되지 않은 구매/사용/섭취 경험을 만들어내지 않는다.`;
  if(!src.includes(commonToneMarker))throw new Error('[CONTENT MIX PATCH] common tone marker not found');
  src=src.replace(commonToneMarker,commonToneInsert);

  const lifestyleMarker=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 상황→불편/발견→반응의 흐름을 우선한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  const lifestyleInsert=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 실제 Threads 생활글처럼 쓴다.\n- 기본 호흡 예시는 '와 이거 대박이야ㅋㅋ' → 생활 불편 1~2줄 → '근데 이거 한번 써보고 좀 놀람'처럼 발견/사용 장면 → 확인 가능한 결과 하나 → '나 이걸 왜 이제 알았지' 같은 짧은 반응이다. 예시 문장을 매번 그대로 복사하지 말고 소재에 맞게 자연스럽게 변주한다.\n- 원 Threads 소재에 실제로 있는 사건·관계·장소·불편만 사용하고 새로운 남편/친구/엄마/구매/사용 경험을 만들어내지 않는다. 원문에 실제 사용 경험이 없으면 '영상 보다가 봤는데', '이런 게 있더라', '보니까'처럼 사실 범위 안에서 쓴다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- 제품 장점은 본문에서 최대 하나만 전면에 둔다.\n- 4~8개의 짧은 줄을 기본으로 하고 의미 덩어리 사이에는 빈 줄을 허용한다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  if(!src.includes(lifestyleMarker))throw new Error('[CONTENT MIX PATCH] lifestyle marker not found');
  src=src.replace(lifestyleMarker,lifestyleInsert);

  const buildMarker="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  let lastError=null;";
  const buildInsert="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  const preferredMode=preferredContentMode(accountId);\n  let mixMisses=0;\n  console.log(`[AutopilotV3][CONTENT MIX] account=${accountId} target=30/30/40 preferred=${preferredMode} softFallback=ON`);\n  let lastError=null;";
  if(!src.includes(buildMarker))throw new Error('[CONTENT MIX PATCH] build marker not found');
  src=src.replace(buildMarker,buildInsert);

  const analysisMarker="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(!analysis.searchTerms.length){";
  const analysisInsert="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(analysis.mode!==preferredMode&&idx<materials.length-1&&mixMisses<1){\n        mixMisses++;\n        console.log(`[AutopilotV3][CONTENT MIX SKIP] preferred=${preferredMode} got=${analysis.mode} @${material.username||'-'} → 1회만 다음 소재`);\n        continue;\n      }\n      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 발행률 우선 진행`);\n      if(!analysis.searchTerms.length){";
  if(!src.includes(analysisMarker))throw new Error('[CONTENT MIX PATCH] analysis marker not found');
  src=src.replace(analysisMarker,analysisInsert);

  const successMarker="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode}`);\n      return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
  const successInsert="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode}`);\n      advanceContentMode(accountId);\n      return{text:decodeEscapedNewlines(generated.text),commentLead:decodeEscapedNewlines(generated.commentLead),product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
  if(!src.includes(successMarker))throw new Error('[CONTENT MIX PATCH] success marker not found');
  src=src.replace(successMarker,successInsert);
  return src;
}

fs.readFileSync=function(filename,...args){
  const data=originalReadFileSync(filename,...args);
  if(!applied&&path.resolve(String(filename))===target){
    const isBuffer=Buffer.isBuffer(data);
    const src=isBuffer?data.toString('utf8'):String(data);
    const transformed=transformSource(src);
    applied=true;
    fs.readFileSync=originalReadFileSync;
    console.log('[Autopilot][CONTENT MIX PATCH] 30/30/40 + Threads human rhythm + literal \\n 정규화 소스주입 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/생활썰40 · 사람 말투/빈줄 호흡 활성화');
