const fs=require('fs');
const path=require('path');

const target=path.resolve(path.join(__dirname,'autopilotMaterialEngine.js'));
const originalReadFileSync=fs.readFileSync.bind(fs);
let applied=false;

function transformSource(src){
  const dbImportMarker="const { getAccount, getSystemApiSettings } = require('./db');";
  const dbImportInsert="const { db, getAccount, getSystemApiSettings } = require('./db');";
  if(!src.includes(dbImportMarker))throw new Error('[CONTENT MIX PATCH] db import marker not found');
  src=src.replace(dbImportMarker,dbImportInsert);

  const cleanMarker="function clean(v){return String(v||'').replace(/\\s+/g,' ').trim();}";
  const cleanInsert=`${cleanMarker}\nfunction decodeEscapedNewlines(v){return String(v||'').replace(/\\\\r\\\\n/g,'\\n').replace(/\\\\n/g,'\\n').replace(/\\\\r/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}\nconst CONTENT_MODE_SEQUENCE=[\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'lifestyle',specialStory:false},\n  {mode:'lifestyle',specialStory:true}\n];\nconst contentModeCursor=new Map();\nfunction persistentContentSeed(accountId){try{const row=db.prepare('SELECT COUNT(*) AS c FROM posts WHERE account_id=?').get(accountId);return Number(row?.c||0)%CONTENT_MODE_SEQUENCE.length;}catch(e){console.warn('[AutopilotV3][CONTENT MIX SEED] DB seed 실패 → account seed 사용 '+e.message);return Math.abs(Number(accountId)||0)%CONTENT_MODE_SEQUENCE.length;}}\nfunction currentContentCursor(accountId){if(!contentModeCursor.has(accountId)){const seed=persistentContentSeed(accountId);contentModeCursor.set(accountId,seed);console.log('[AutopilotV3][CONTENT MIX SEED] account='+accountId+' persistentSlot='+seed+'/'+CONTENT_MODE_SEQUENCE.length);}return Number(contentModeCursor.get(accountId)||0)%CONTENT_MODE_SEQUENCE.length;}\nfunction preferredContentSlot(accountId){return CONTENT_MODE_SEQUENCE[currentContentCursor(accountId)];}\nfunction advanceContentMode(accountId){contentModeCursor.set(accountId,(currentContentCursor(accountId)+1)%CONTENT_MODE_SEQUENCE.length);}\nfunction specialStorySignals(v){const t=clean(v);if(!t)return 0;let s=0;for(const r of[/(고체|젤형|캡슐|스틱|패치|롤온)/i,/(자동|센서|감지|무선|진공|압축)/i,/(접이|폴딩|회전|자석|마그넷|걸이|틈새|슬라이드)/i,/(미니|휴대|포켓|벽걸이|부착|클립)/i,/(전용|일체형|분리형|다기능)/i])if(r.test(t))s++;return s;}\nfunction specialStoryScore(material,analysis,vision){const evidence=[analysis?.topic,analysis?.secretTerm,...(analysis?.searchTerms||[]),vision?.soldObject,vision?.evidence,material?.sourceText,material?.authorReplies].filter(Boolean).join(' ');let s=specialStorySignals(evidence);if(/(냄새|악취|얼룩|물때|곰팡|먼지|정리|수납|젖|습기|빨래|청소|신발|화장실|욕실|주방|차량|침대|옷장|냉장고|반려|집들이)/i.test(evidence))s+=1;if(/(뭐지|신기|처음|이런 게|특이|놀|ㅋㅋ|;;|ㅠㅠ)/i.test(evidence))s+=1;return s;}\nfunction isSpecialStoryCandidate(material,analysis,vision){return specialStoryScore(material,analysis,vision)>=2;}`;
  if(!src.includes(cleanMarker))throw new Error('[CONTENT MIX PATCH] clean marker not found');
  src=src.replace(cleanMarker,cleanInsert);

  // Voice belongs to threadsVoicePolicy. Content mix only selects product/recipe slots.
  // Do not replace prompt prose: it caused startup failures and overrode the shared guide.

  const buildMarker="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  let lastError=null;";
  const buildInsert="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  const preferredSlot=preferredContentSlot(accountId);\n  const preferredMode=preferredSlot.mode;\n  const specialStoryWanted=preferredSlot.specialStory===true;\n  console.log(`[AutopilotV3][CONTENT MIX] account=${accountId} target=45/45/10 preferred=${preferredMode} specialStory=${specialStoryWanted?'ON':'OFF'} sourcePreserve=90% lifestyle=10%`);\n  let lastError=null;";
  if(!src.includes(buildMarker))throw new Error('[CONTENT MIX PATCH] build marker not found');
  src=src.replace(buildMarker,buildInsert);

  const analysisMarker="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(!analysis.searchTerms.length){";
  const analysisInsert="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(preferredMode==='product'&&analysis.mode==='lifestyle'&&analysis.searchTerms.length>0){analysis.mode='product';console.log(`[AutopilotV3][CONTENT MIX PRODUCT LOCK] preferred=product got=lifestyle sellable=yes → source-preserve product`);}\n      if(preferredMode==='lifestyle'&&analysis.mode!=='lifestyle'){const detected=analysis.mode;analysis.mode='lifestyle';console.log(`[AutopilotV3][LIFESTYLE SLOT LOCK] preferred=lifestyle detected=${detected} → 10% lifestyle 슬롯 강제`);}\n      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 후보 소모 없이 발행 시도`);\n      const specialStory=analysis.mode==='lifestyle'&&specialStoryWanted&&isSpecialStoryCandidate(material,analysis,vision);\n      if(analysis.mode==='lifestyle'&&specialStoryWanted&&!specialStory)console.log(`[AutopilotV3][SPECIAL STORY FALLBACK] score=${specialStoryScore(material,analysis,vision)} → 일반 lifestyle로 발행 시도`);\n      if(specialStory)console.log(`[AutopilotV3][SPECIAL STORY] selected score=${specialStoryScore(material,analysis,vision)} @${material.username||'-'}`);\n      if(!analysis.searchTerms.length){";
  if(!src.includes(analysisMarker))throw new Error('[CONTENT MIX PATCH] analysis marker not found');
  src=src.replace(analysisMarker,analysisInsert);

  const generateMarker="      const generated=await generatePost(accountId,{material,analysis,product:found.product,target});";
  const generateInsert="      const generated=await generatePost(accountId,{material,analysis:{...analysis,specialStory:Boolean(specialStory)},product:found.product,target});";
  if(!src.includes(generateMarker))throw new Error('[CONTENT MIX PATCH] generate marker not found');
  src=src.replace(generateMarker,generateInsert);

  const successMarker="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode}`);\n      return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceText:material.sourceText,authorReplies:material.authorReplies,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
  const successInsert="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode} specialStory=${Boolean(specialStory)} sourcePreserve=${analysis.mode==='lifestyle'?'OFF':'ON'}`);\n      advanceContentMode(accountId);\n      const textOnly=analysis.mode==='lifestyle';\n      if(textOnly)console.log('[AutopilotV3][LIFESTYLE TEXT ONLY] source media suppressed');\n      return{text:decodeEscapedNewlines(generated.text),commentLead:decodeEscapedNewlines(generated.commentLead),product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,specialStory:Boolean(specialStory),sourceUrl:material.url,sourceUsername:material.username||null,sourceText:material.sourceText,authorReplies:material.authorReplies,sourceImages:textOnly?[]:(Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[]),sourceVideos:textOnly?[]:(Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[]),referenceImage:textOnly?null:(material.images?.[0]||null),visionTarget:vision};";
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
    console.log('[Autopilot][CONTENT MIX PATCH] content slot selector + persistent cursor 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] content slot selector armed; voice policy is separate');


