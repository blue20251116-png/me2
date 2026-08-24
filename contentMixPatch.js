const fs=require('fs');
const path=require('path');

const target=path.resolve(path.join(__dirname,'autopilotMaterialEngine.js'));
const originalReadFileSync=fs.readFileSync.bind(fs);
let applied=false;

function transformSource(src){
  const cleanMarker="function clean(v){return String(v||'').replace(/\\s+/g,' ').trim();}";
  const cleanInsert=`${cleanMarker}\nfunction decodeEscapedNewlines(v){return String(v||'').replace(/\\\\r\\\\n/g,'\\n').replace(/\\\\n/g,'\\n').replace(/\\\\r/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}\n// 기존 mode(product/recipe/lifestyle)는 유지한다. lifestyle 4칸 중 2칸만 specialStory로 표시해 전체 30/30/20/20을 만든다.\nconst CONTENT_MODE_SEQUENCE=[\n  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'lifestyle',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'lifestyle',specialStory:true},\n  {mode:'recipe',specialStory:false},\n  {mode:'product',specialStory:false},\n  {mode:'lifestyle',specialStory:false},\n  {mode:'recipe',specialStory:false},\n  {mode:'lifestyle',specialStory:true}\n];\nconst contentModeCursor=new Map();\nfunction preferredContentSlot(accountId){const i=Number(contentModeCursor.get(accountId)||0)%CONTENT_MODE_SEQUENCE.length;return CONTENT_MODE_SEQUENCE[i];}\nfunction preferredContentMode(accountId){return preferredContentSlot(accountId).mode;}\nfunction advanceContentMode(accountId){contentModeCursor.set(accountId,(Number(contentModeCursor.get(accountId)||0)+1)%CONTENT_MODE_SEQUENCE.length);}\nfunction specialStorySignals(v){const t=clean(v);if(!t)return 0;let s=0;for(const r of[/(고체|젤형|캡슐|스틱|패치|롤온)/i,/(자동|센서|감지|무선|진공|압축)/i,/(접이|폴딩|회전|자석|마그넷|걸이|틈새|슬라이드)/i,/(미니|휴대|포켓|벽걸이|부착|클립)/i,/(전용|일체형|분리형|다기능)/i])if(r.test(t))s++;return s;}\nfunction specialStoryScore(material,analysis,vision){const evidence=[analysis?.topic,analysis?.secretTerm,...(analysis?.searchTerms||[]),vision?.soldObject,vision?.evidence,material?.sourceText,material?.authorReplies].filter(Boolean).join(' ');let s=specialStorySignals(evidence);if(/(냄새|악취|얼룩|물때|곰팡|먼지|정리|수납|젖|습기|빨래|청소|신발|화장실|욕실|주방|차량|침대|옷장|냉장고|반려|집들이)/i.test(evidence))s+=1;if(/(뭐지|신기|처음|이런 게|특이|놀|ㅋㅋ|;;|ㅠㅠ)/i.test(evidence))s+=1;return s;}\nfunction isSpecialStoryCandidate(material,analysis,vision){return specialStoryScore(material,analysis,vision)>=2;}`;
  if(!src.includes(cleanMarker))throw new Error('[CONTENT MIX PATCH] clean marker not found');
  src=src.replace(cleanMarker,cleanInsert);

  const commonToneMarker=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 반응·상황·의외성·궁금증으로 시작한다.\n- ㅋㅋ는 자연스러울 때 최대 1~2회만. 억지 유행어 금지.\n- 확인되지 않은 구매/사용/섭취 경험을 만들어내지 않는다.`;
  const commonToneInsert=`- 첫 문장에서 '~은/는 ...입니다'처럼 정의하지 않는다. 실제 Threads 사람이 쓰는 짧은 반응이나 생활 상황으로 시작한다.\n- '와 이거 대박이야ㅋㅋ', '이거 진짜 미쳤다ㅋㅋ', '아니 이거 뭐야ㅋㅋ', '와 이런 게 있었네ㅋㅋ' 같은 즉흥 반응형 시작을 적극 허용한다. 다만 같은 첫 문장을 연속 글에서 반복하지 않는다.\n- 본문은 반응/상황 → 실제 불편이나 궁금증 → 발견/제품 장면 → 기능 또는 결과 하나 → 짧은 반응 순서로 쓴다.\n- 한 줄에 한 생각만 쓰고 1~2줄마다 빈 줄을 둘 수 있다. 설명문처럼 문장을 붙이지 않는다.\n- ㅋㅋ는 자연스러울 때 0~2회 사용할 수 있다.\n- 광고 카피처럼 장점을 나열하지 말고 사람이 직접 피드에 쓴 것처럼 짧고 날것의 표현을 우선한다.\n- 생활 장면과 주변 반응은 자연스러운 서사 장치로 활용할 수 있다. 다만 브랜드명·모델명·수치·가격·효능처럼 검증 가능한 상품 사실은 입력 근거 없이 만들지 않는다.`;
  if(!src.includes(commonToneMarker))throw new Error('[CONTENT MIX PATCH] common tone marker not found');
  src=src.replace(commonToneMarker,commonToneInsert);

  const lifestyleMarker=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 상황→불편/발견→반응의 흐름을 우선한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  const lifestyleInsert=`[일반상품/생활]\n- 본문 text는 제품 설명서가 아니라 실제 Threads 생활글처럼 쓴다.\n- 생활 사건 → 구체적인 사소한 디테일 → 감정/주변 반응 → 문제 확대 또는 의외성 → 제품/해결책 등장 흐름을 우선하되 순서는 소재에 맞게 바꾼다.\n- 집들이 때 꺼냈더니 다들 반응했다 같은 일상적 주변반응 서사는 자연스럽게 활용할 수 있다. 매번 남편/아이/친구/집들이만 반복하지 말고 자취·회사·차량·청소·빨래·요리·정리·출근·밤중 상황 등 배경을 다양하게 쓴다.\n- 제품 설명을 앞세우지 않는다. 생활썰에서는 가능하면 제품/해결책을 본문 후반에 등장시키고 앞부분은 사건 자체로 읽히게 한다.\n- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.\n- 검증 가능한 브랜드명·모델명·수치·가격·효능은 원문/판매대상 근거가 있을 때만 쓴다.\n- 제품 장점을 직접 나열하기보다 사건의 결과나 주변 반응으로 보여준다.\n- 6~12개의 짧은 행을 허용하고 의미 덩어리 사이에는 빈 줄을 둘 수 있다.\n- commentLead에는 '✅ 핵심만' 아래 핵심 포인트 2~3개만 간결하게 쓴다.`;
  if(!src.includes(lifestyleMarker))throw new Error('[CONTENT MIX PATCH] lifestyle marker not found');
  src=src.replace(lifestyleMarker,lifestyleInsert);

  const buildMarker="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  let lastError=null;";
  const buildInsert="async function buildThreadsFirstAutopilot(accountId,{target}){\n  const materials=await collectQualifiedThreadsMaterials(6);\n  const preferredSlot=preferredContentSlot(accountId);\n  const preferredMode=preferredSlot.mode;\n  const specialStoryWanted=preferredSlot.specialStory===true;\n  let mixMisses=0;\n  let specialStoryMisses=0;\n  console.log(`[AutopilotV3][CONTENT MIX] account=${accountId} target=30/30/20/20 preferred=${preferredMode} specialStory=${specialStoryWanted?'ON':'OFF'} softFallback=ON`);\n  let lastError=null;";
  if(!src.includes(buildMarker))throw new Error('[CONTENT MIX PATCH] build marker not found');
  src=src.replace(buildMarker,buildInsert);

  const analysisMarker="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(!analysis.searchTerms.length){";
  const analysisInsert="      const analysis=await analyzeMaterial(accountId,material,target,vision);\n      if(analysis.mode!==preferredMode&&idx<materials.length-1&&mixMisses<1){\n        mixMisses++;\n        console.log(`[AutopilotV3][CONTENT MIX SKIP] preferred=${preferredMode} got=${analysis.mode} @${material.username||'-'} → 1회만 다음 소재`);\n        continue;\n      }\n      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 발행률 우선 진행`);\n      const specialStory=analysis.mode==='lifestyle'&&specialStoryWanted&&isSpecialStoryCandidate(material,analysis,vision);\n      if(analysis.mode==='lifestyle'&&specialStoryWanted&&!specialStory&&idx<materials.length-1&&specialStoryMisses<1){\n        specialStoryMisses++;\n        console.log(`[AutopilotV3][SPECIAL STORY SKIP] score=${specialStoryScore(material,analysis,vision)} @${material.username||'-'} → 특이상품/썰감 후보 1회만 추가 탐색`);\n        continue;\n      }\n      if(analysis.mode==='lifestyle'&&specialStoryWanted&&!specialStory)console.log(`[AutopilotV3][SPECIAL STORY FALLBACK] 특이상품 후보 없음 → 일반 lifestyle로 발행률 유지`);\n      if(specialStory)console.log(`[AutopilotV3][SPECIAL STORY] selected score=${specialStoryScore(material,analysis,vision)} @${material.username||'-'}`);\n      if(!analysis.searchTerms.length){";
  if(!src.includes(analysisMarker))throw new Error('[CONTENT MIX PATCH] analysis marker not found');
  src=src.replace(analysisMarker,analysisInsert);

  const generateMarker="      const generated=await generatePost(accountId,material,analysis,found.product);";
  const generateInsert="      const generated=await generatePost(accountId,material,{...analysis,specialStory:Boolean(specialStory)},found.product);";
  if(!src.includes(generateMarker))throw new Error('[CONTENT MIX PATCH] generate marker not found');
  src=src.replace(generateMarker,generateInsert);

  const successMarker="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode}`);\n      return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
  const successInsert="      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product=\"${found.product.name}\" mode=${analysis.mode} specialStory=${Boolean(specialStory)}`);\n      advanceContentMode(accountId);\n      return{text:decodeEscapedNewlines(generated.text),commentLead:decodeEscapedNewlines(generated.commentLead),product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,specialStory:Boolean(specialStory),sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};";
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
    console.log('[Autopilot][CONTENT MIX PATCH] 30/30/20/20 + special-story soft target + literal \\n 정규화 소스주입 완료');
    return isBuffer?Buffer.from(transformed,'utf8'):transformed;
  }
  return data;
};

console.log('[Autopilot][CONTENT MIX PATCH] 일반30/레시피30/일반생활썰20/특이상품생활썰20 · 기존 mode 유지');
