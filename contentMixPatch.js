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
  const commonToneInsert=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 반응·상황·의외성·궁금증으로 시작한다.\n- 첫 문장을 '와 이거', '와 ㅁㅊ', '와 미쳤다', '이거 진짜 미쳤다', '대박임' 같은 상투적인 감탄 공식으로 시작하지 않는다.\n- 매 글마다 감탄사를 붙이지 않는다. 소재에 맞춰 사건형·관찰형·결과선공개형·공감형·궁금증형·짧은 반응형 중 자연스러운 시작을 고른다.\n- ㅋㅋ는 자연스러울 때 최대 1회만 쓴다. ㅠㅠ, ㄷㄷ, ㅁㅊ, 대박 같은 표현도 습관적으로 반복하지 않는다. 원 Threads 소재의 분위기에 맞을 때만 제한적으로 쓴다.\n- 같은 의미를 '진짜', '완전', '대박', '미쳤다'로 겹쳐 강조하지 않는다.\n- 확인되지 않은 구매/사용/섭취 경험을 만들어내지 않는다.`;
  if(!src.includes(commonToneMarker))throw new Error('[CONTENT MIX PATCH] common tone marker not found');
  src=src.replace(commonToneMarker,commonToneInsert);

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
    console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/생활썰40 + 후킹 반복 억제 + literal \\n 줄바꿈 정규화 소스주입 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/생활썰40 + 후킹 반복 억제 활성화');
