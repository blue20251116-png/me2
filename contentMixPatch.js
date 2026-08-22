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

  const lifestyleMarker=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 상황→불편/발견→반응의 흐름을 우선한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  const lifestyleInsert=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 상황→불편/발견→반응의 흐름을 우선한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.\n- mode가 lifestyle이면 생활썰형으로 쓴다. 원 Threads 소재에 실제로 있는 사건·관계·장소·불편만 사용하고 새로운 남편/친구/엄마/구매/사용 경험을 만들어내지 않는다.\n- lifestyle 본문은 생활 사건이나 당황스러운 순간으로 시작하고 → 왜 그런지 궁금하게 만들고 → 불편 또는 발견을 보여주고 → 해결 상품은 후반에 짧게 드러내는 흐름을 우선한다.\n- lifestyle에서 제품 장점 2~3개를 본문에 나열하지 않는다. 제품을 팔기 위한 설명보다 사건 자체가 먼저 읽혀야 한다.\n- lifestyle 첫 1~2줄은 상품명을 몰라도 계속 읽고 싶게 만든다.\n- 원문에 없는 냄새·남편·친구·엄마 같은 소재를 성공 공식처럼 반복해서 붙이지 않는다.\n- '이걸 왜 이제 알았지' 같은 동일 결말을 매번 쓰지 않는다. 원문 상황에 맞게 자연스럽게 끝낸다.`;
  if(!src.includes(lifestyleMarker))throw new Error('[CONTENT MIX PATCH] lifestyle marker not found');
  src=src.replace(lifestyleMarker,lifestyleInsert);

  const buildMarker="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  let lastError=null;";
  const buildInsert="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  const preferredMode=preferredContentMode(accountId);\n  console.log(`[AutopilotV3][CONTENT MIX] account=${accountId} target=30/30/40 preferred=${preferredMode}`);\n  let lastError=null;";
  if(!src.includes(buildMarker))throw new Error('[CONTENT MIX PATCH] build marker not found');
  src=src.replace(buildMarker,buildInsert);

  const analysisMarker="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(!analysis.searchTerms.length){";
  const analysisInsert="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(analysis.mode!==preferredMode&&idx<materials.length-1){\n        console.log(`[AutopilotV3][CONTENT MIX SKIP] preferred=${preferredMode} got=${analysis.mode} @${material.username||'-'} → 다음 소재`);\n        continue;\n      }\n      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX FALLBACK] preferred=${preferredMode} got=${analysis.mode} - 후보 부족으로 진행`);\n      if(!analysis.searchTerms.length){";
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
    console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/생활썰40 + literal \\n 줄바꿈 정규화 소스주입 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/생활썰40 + 줄바꿈 정규화 활성화');
