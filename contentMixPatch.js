const fs=require('fs');
const path=require('path');

const target=path.resolve(path.join(__dirname,'autopilotMaterialEngine.js'));
const originalReadFileSync=fs.readFileSync.bind(fs);
let applied=false;

function transformSource(src){
  const cleanMarker="function clean(v){return String(v||'').replace(/\\s+/g,' ').trim();}";
  const cleanInsert=`${cleanMarker}\nfunction decodeEscapedNewlines(v){return String(v||'').replace(/\\\\r\\\\n/g,'\\n').replace(/\\\\n/g,'\\n').replace(/\\\\r/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}\nconst CONTENT_MODE_SEQUENCE=['product','recipe','lifestyle','product','recipe','lifestyle','product','recipe','lifestyle','product'];\nconst contentModeCursor=new Map();\nfunction preferredContentMode(accountId){const i=Number(contentModeCursor.get(accountId)||0)%CONTENT_MODE_SEQUENCE.length;return CONTENT_MODE_SEQUENCE[i];}\nfunction advanceContentMode(accountId){contentModeCursor.set(accountId,(Number(contentModeCursor.get(accountId)||0)+1)%CONTENT_MODE_SEQUENCE.length);}`;
  if(!src.includes(cleanMarker))throw new Error('[CONTENT MIX PATCH] clean marker not found');
  src=src.replace(cleanMarker,cleanInsert);

  const buildMarker="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  let lastError=null;";
  const buildInsert="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  const preferredMode=preferredContentMode(accountId);\n  console.log(`[AutopilotV3][CONTENT MIX] account=${accountId} target=40/30/30 preferred=${preferredMode}`);\n  let lastError=null;";
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
    console.log('[Autopilot][CONTENT MIX PATCH] 일반40/레시피30/일상30 + literal \\n 줄바꿈 정규화 소스주입 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 40/30/30 + 줄바꿈 정규화 활성화');
