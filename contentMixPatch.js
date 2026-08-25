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

  const commonToneMarker=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 반응·상황·의외성·궁금증으로 시작한다.\n- ㅋㅋ는 자연스러울 때 최대 1~2회만. 억지 유행어 금지.\n- 확인되지 않은 구매/사용/섭취 경험을 만들어내지 않는다.`;
  const commonToneInsert=`- product와 recipe는 새 글을 창작하지 않는다. 원 Threads 본문의 사건 순서와 핵심 표현의 리듬, 대략적인 문장 수를 최대한 보존하면서 문장 표현만 가볍게 다시 쓴다.\n- 원문에 없는 후킹, 감탄, 반전, 인물, 구매·사용·섭취 경험을 추가하지 않는다.\n- '와 이거 진짜', '아니 이거 뭐야', '대박이야', '미쳤다' 같은 상투 후킹을 새로 만들지 않는다. 원문에 있을 때만 그 감정 강도를 유지하되 문장 자체는 그대로 복사하지 않는다.\n- 원문이 짧으면 짧게 끝내고 원문이 길면 사건 흐름을 유지한다. 3~7줄처럼 줄 수를 억지로 맞추지 않는다.\n- 문장 순서를 임의로 재배열하지 않고 원문의 시작점과 마무리 방식도 가능하면 유지한다.\n- 원문의 고유 문장을 그대로 복사하지 말고 조사, 어미, 어순, 표현을 바꿔 독립적인 문장으로 만든다. 사실과 의미는 추가하거나 빼지 않는다.\n- lifestyle 슬롯일 때만 새 일상글을 작성할 수 있다.\n- 확인되지 않은 구매·사용·섭취 경험, 가족·친구·직장동료·반려동물과의 사건, 집들이·출근·퇴근·육아 같은 개인 경험을 사실처럼 새로 만들지 않는다.\n- 브랜드명·모델명·수치·가격·효능처럼 검증 가능한 상품 사실은 입력 근거 없이 만들지 않는다.`;
  if(!src.includes(commonToneMarker))throw new Error('[CONTENT MIX PATCH] common tone marker not found');
  src=src.replace(commonToneMarker,commonToneInsert);

  const recipeMarker=`[레시피]\n- 본문 text에는 음식의 핵심 장면과 궁금증만 짧게 쓴다.\n- 정확한 제휴 소스/핵심재료 이름은 숨긴다.\n- 마지막은 '재료랑 만드는 법은 댓글에 적어둘게'처럼 자연스럽게 끝낼 수 있다.`;
  const recipeInsert=`[레시피]\n- 본문 text는 원 Threads 본문의 사건 순서와 말의 호흡을 최대한 유지해서 최소 재작성한다.\n- 원문에 없는 감탄, 맛 평가, 사용 경험, 후킹을 새로 만들지 않는다.\n- 정확한 제휴 소스/핵심재료 이름은 숨긴다.\n- 원문에 댓글 유도가 있으면 그 의도만 자연스럽게 유지하고 원문에 없으면 새 CTA를 만들지 않는다.`;
  if(!src.includes(recipeMarker))throw new Error('[CONTENT MIX PATCH] recipe marker not found');
  src=src.replace(recipeMarker,recipeInsert);

  const lifestyleMarker=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 상황→불편/발견→반응의 흐름을 우선한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  const lifestyleInsert=`[일반상품/생활]\n- analysis.mode가 product이면 원 Threads 본문을 기준으로 최소 재작성한다. 사건 순서, 시작점, 대략적인 길이와 호흡은 유지하고 표현만 가볍게 바꾼다.\n- product에서는 새로운 상황→불편→발견→반응 구조를 만들지 않는다. 원문이 관찰형이면 관찰형으로, 질문형이면 질문형으로, 짧은 반응형이면 짧은 반응형으로 유지한다.\n- product에서는 원문에 없는 '와 이거 진짜', '아니 이거 뭐야', '대박', '미쳤다', ㅋㅋ, ㅠㅠ, ㄷㄷ 같은 반응을 새로 추가하지 않는다.\n- product에서는 '비밀 재료', '비밀 소스', 레시피 댓글 유도 같은 음식 전용 표현을 절대 쓰지 않는다.\n- analysis.mode가 lifestyle일 때만 새 일상글을 작성한다. lifestyle은 전체 발행의 10% 슬롯에서만 선택된다.\n- lifestyle에서는 상품 홍보를 앞세우지 않고 사람의 상황·관찰·생각이 중심이 되게 쓴다.\n- analysis.specialStory가 true인 lifestyle만 특수상품 일상썰 구조를 사용할 수 있다. 확인되지 않은 구체적 인물·구매·사용 사실은 만들지 않는다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- 검증 가능한 브랜드명·모델명·수치·가격·효능은 원문/판매대상 근거가 있을 때만 쓴다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  if(!src.includes(lifestyleMarker))throw new Error('[CONTENT MIX PATCH] lifestyle marker not found');
  src=src.replace(lifestyleMarker,lifestyleInsert);

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

  const successMarker="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode}`);\n      return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
  const successInsert="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode} specialStory=${Boolean(specialStory)} sourcePreserve=${analysis.mode==='lifestyle'?'OFF':'ON'}`);\n      advanceContentMode(accountId);\n      const textOnly=analysis.mode==='lifestyle';\n      if(textOnly)console.log('[AutopilotV3][LIFESTYLE TEXT ONLY] source media suppressed');\n      return{text:decodeEscapedNewlines(generated.text),commentLead:decodeEscapedNewlines(generated.commentLead),product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,specialStory:Boolean(specialStory),sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:textOnly?[]:(Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[]),sourceVideos:textOnly?[]:(Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[]),referenceImage:textOnly?null:(material.images?.[0]||null),visionTarget:vision};";
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
    console.log('[Autopilot][CONTENT MIX PATCH] source-preserve 90% + lifestyle 10% + persistent cursor 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 일반/레시피 90% 원문보존형 · 일상 10% AI작성 · 고정 후킹 예문 제거');
