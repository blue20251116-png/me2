const { normalizeVoice, voiceGuide, formatVoice, voiceProblems, assertVoice, reviewSourceVoice } = require('./threadsVoicePolicy');
const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const { collectBenchmarkMaterials, collectPostDetails, markUsedPost } = require('./benchmarkAccounts');
const coupangApi = require('./coupangApi');

function getOpenAIKey(accountId){
  const a=getAccount(accountId),s=getSystemApiSettings();
  return s.openai_api_key||process.env.OPENAI_API_KEY||a?.openai_api_key||null;
}
async function callOpenAI(accountId,system,user,{maxTokens=1800,temperature=.55}={}){
  const apiKey=getOpenAIKey(accountId);
  if(!apiKey)throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const r=await axios.post('https://api.openai.com/v1/chat/completions',{
    model:'gpt-4o-mini',temperature,max_tokens:maxTokens,response_format:{type:'json_object'},
    messages:[{role:'system',content:system},{role:'user',content:user}]
  },{headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:45000});
  const raw=r.data?.choices?.[0]?.message?.content;
  if(!raw)throw new Error('AI 결과가 비어 있습니다');
  return JSON.parse(raw);
}
async function callOpenAIVision(accountId,system,text,imageUrls,{maxTokens=1400,temperature=.15}={}){
  const apiKey=getOpenAIKey(accountId);
  if(!apiKey)throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const content=[{type:'text',text}];
  for(const url of (imageUrls||[]).filter(Boolean).slice(0,3))content.push({type:'image_url',image_url:{url}});
  const r=await axios.post('https://api.openai.com/v1/chat/completions',{
    model:'gpt-4o-mini',temperature,max_tokens:maxTokens,response_format:{type:'json_object'},
    messages:[{role:'system',content:system},{role:'user',content}]
  },{headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:45000});
  const raw=r.data?.choices?.[0]?.message?.content;
  if(!raw)throw new Error('Vision 결과가 비어 있습니다');
  return JSON.parse(raw);
}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function normalized(v){return clean(v).toLowerCase().replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g,'');}
function hasExternalLink(t){return/(?:https?:\/\/|www\.)\S+/i.test(String(t||''))||/\b(?:link\.coupang\.com|naver\.me)\b/i.test(String(t||''));}
function hasAffiliateLink(t){
  const s=String(t||'');
  return /(?:https?:\/\/)?(?:link\.)?coupang\.com\//i.test(s)
    || /link\.coupang\.com/i.test(s)
    || /(?:https?:\/\/)?(?:naver\.me|shopping\.naver\.com|smartstore\.naver\.com|brand\.naver\.com)\//i.test(s)
    || /네이버\s*(?:쇼핑)?\s*(?:커넥트|링크)/i.test(s);
}
function isEngagementBait(text){
  const t=clean(text);if(!t)return false;
  const hard=[/스하(?:뤼|리|루)?/i,/반하(?:뤼|리|루)?/i,/맞팔/i,/선팔/i,/팔로우\s*(?:3종|세트|가자|하면|해주|부탁|환영|갈게|갑니다)/i,/하트[^\n]{0,30}팔로우/i,/팔로우[^\n]{0,30}하트/i,/리포스트[^\n]{0,30}팔로우/i,/팔로우[^\n]{0,30}리포스트/i,/스레드\s*(?:이제|막)?\s*시작한\s*사람/i,/\d{2,6}\s*명까지\s*포기\s*못/i,/같이\s*성장하(?:자|쟈)/i,/바로\s*팔로우\s*(?:갈게|갑니다|감)/i,/팔로우하면\s*(?:바로|무조건)?\s*팔로우/i];
  if(hard.some(r=>r.test(t)))return true;
  let hits=0;
  for(const r of[/팔로우/i,/리포스트/i,/하트/i,/성장/i,/맞팔/i,/선팔/i])if(r.test(t))hits++;
  return hits>=3;
}
function materialFingerprint(item){
  const t=normalized(item?.text||'').replace(/\d+/g,'#');
  return t.slice(0,260);
}
function dedupeMaterials(items){
  const seenUrl=new Set(),seenText=new Set(),out=[];
  for(const item of items||[]){
    const url=String(item?.url||'').split(/[?#]/)[0];
    const fp=materialFingerprint(item);
    if(!url||seenUrl.has(url))continue;
    if(fp.length>=20&&seenText.has(fp))continue;
    seenUrl.add(url);
    if(fp.length>=20)seenText.add(fp);
    out.push(item);
  }
  return out;
}
function materialScore(i){
  const t=clean(i?.text);if(isEngagementBait(t))return-1000;
  let s=0;
  if(i?.hasVideo||Number(i?.videoCount||0)>0)s+=2;
  if(Number(i?.imageCount||0)>0||(Array.isArray(i?.images)&&i.images.length))s+=1;
  if(t.length>=40&&t.length<=1000)s+=4;else if(t.length>=20)s+=2;
  if(/(레시피|소스|양념|재료|만드는|볶|굽|끓|에어프라이어|큰술|스푼|\bT\b)/i.test(t))s+=5;
  if(/(비밀|핵심|이거|댓글|진짜|ㅋㅋ|꿀템|사버|추천|구매|제품)/i.test(t))s+=3;
  if(hasExternalLink(t))s-=30;
  return s+Math.random();
}
async function pickThreadsMaterials(){
  const m=await collectBenchmarkMaterials({limit:60});
  const filtered=(m||[]).filter(x=>x?.url&&clean(x.text).length>=12&&!hasExternalLink(x.text)&&!isEngagementBait(x.text));
  const u=dedupeMaterials(filtered);
  if(!u.length)throw new Error('Threads에서 사용할 소재를 찾지 못했습니다');
  u.sort((a,b)=>materialScore(b)-materialScore(a));
  console.log(`[AutopilotV3][Material] 수집=${m?.length||0} 필터후=${filtered.length} 중복제거후=${u.length}`);
  return u;
}
async function enrichThreadsMaterial(i){
  let sourceText=clean(i?.text),authorReplies='',images=Array.isArray(i?.images)?i.images.filter(Boolean):[],videos=[];
  if(i?.url&&i?.username){
    const d=await collectPostDetails(i.url,i.username);
    if(clean(d?.sourceText).length>=8)sourceText=clean(d.sourceText);
    authorReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean).join('\n\n'):'';
    if(Array.isArray(d?.images)&&d.images.length)images=d.images.filter(Boolean);
    if(Array.isArray(d?.videos))videos=d.videos.filter(Boolean);
  }
  if(isEngagementBait(sourceText)||isEngagementBait(authorReplies))throw new Error('팔로우/맞팔/리포스트 유도형 소재');
  if(!hasAffiliateLink(authorReplies))throw new Error('작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');
  return{...i,sourceText,authorReplies,images,videos};
}
async function collectQualifiedThreadsMaterials(maxQualified=6){
  const candidates=await pickThreadsMaterials();
  const out=[];
  let lastError=null;
  for(const candidate of candidates.slice(0,60)){
    try{
      const material=await enrichThreadsMaterial(candidate);
      out.push(material);
      console.log(`[AutopilotV3][Material] 후보채택 ${out.length}/${maxQualified} @${material.username||'-'} 쇼핑링크 확인 source=${material.url}`);
      if(out.length>=maxQualified)break;
    }catch(e){
      lastError=e;
      console.log(`[AutopilotV3][Material] 제외 @${candidate.username||'-'} reason="${e.message}" source=${candidate.url}`);
    }
  }
  if(!out.length)throw new Error(`조건에 맞는 소재를 찾지 못했습니다${lastError?`: ${lastError.message}`:''}`);
  return out;
}
function grounded(term,evidence){
  const t=normalized(term),e=normalized(evidence);if(!t||!e)return false;
  if(e.includes(t))return true;
  const tokens=clean(term).split(/\s+/).map(normalized).filter(x=>x.length>=2);
  return tokens.length>0&&tokens.every(x=>e.includes(x));
}
function commerceTargetPrompt(){return `너는 Threads 쇼핑 소재의 실제 판매/추천 대상을 식별하는 검수자다. 본문과 작성자 댓글을 우선 보고, 이미지가 제공되면 보조 근거로만 사용한다. 화면에 보이는 주변 물건을 판매 대상으로 착각하지 않는다. 음식이면 완성요리와 실제 제휴 핵심재료/소스/조미료를 구분한다. 브랜드/모델은 근거가 있을 때만 쓴다. searchTerms는 쿠팡에서 실제 상품을 찾기 좋은 검색어 최대 2개다. 단순 주제어(예: 운동, 다이어트, 일상)만 쓰지 말고 실제 구매 가능한 물건/식품명이어야 한다. JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","searchTerms":[""],"confidence":0,"evidence":""}`;}
function commerceTargetText(m){return `[Threads 본문]\n${m.sourceText.slice(0,4500)}\n\n[작성자 댓글]\n${m.authorReplies.slice(0,3500)||'(없음)'}`;}
function normalizeVisionResult(d){
  return{
    kind:['product','food','recipe','lifestyle'].includes(d?.kind)?d.kind:'product',
    soldObject:clean(d?.soldObject),dish:clean(d?.dish),promotedIngredient:clean(d?.promotedIngredient),
    searchTerms:[...new Set((Array.isArray(d?.searchTerms)?d.searchTerms:[]).map(clean).filter(Boolean))].slice(0,2),
    confidence:Math.max(0,Math.min(100,Number(d?.confidence)||0)),evidence:clean(d?.evidence).slice(0,300)
  };
}
async function identifyCommerceTarget(accountId,m){
  const images=(Array.isArray(m.images)?m.images:[]).filter(Boolean).slice(0,3);
  const system=commerceTargetPrompt();
  const text=commerceTargetText(m);
  if(images.length){
    try{
      const d=await callOpenAIVision(accountId,system,`${text}\n\n대표 시각자료 ${images.length}장.`,images,{maxTokens:1200,temperature:.1});
      const result=normalizeVisionResult(d);
      console.log(`[AutopilotV3][VISION TARGET] kind=${result.kind} sold="${result.soldObject||'-'}" dish="${result.dish||'-'}" ingredient="${result.promotedIngredient||'-'}" confidence=${result.confidence} terms="${result.searchTerms.join(' / ')}"`);
      return result;
    }catch(e){
      console.warn(`[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);
    }
  }
  try{
    const d=await callOpenAI(accountId,system,text,{maxTokens:1200,temperature:.1});
    const result=normalizeVisionResult(d);
    console.log(`[AutopilotV3][TEXT TARGET] kind=${result.kind} sold="${result.soldObject||'-'}" dish="${result.dish||'-'}" ingredient="${result.promotedIngredient||'-'}" confidence=${result.confidence} terms="${result.searchTerms.join(' / ')}"`);
    return result;
  }catch(e){
    console.warn(`[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status||'-'} ${e.response?.data?.error?.message||e.message}`);
    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};
  }
}
function purchasableTerm(term){
  const t=clean(term);
  if(!t)return false;
  if(/^(운동|다이어트|건강|요리|레시피|일상|생활|식단|간식|아침|점심|저녁|홈트|헬스)$/i.test(t))return false;
  return t.length>=2;
}
async function analyzeMaterial(accountId,m,target,vision){
  const evidence=`${m.sourceText}\n${m.authorReplies}`;
  const visionText=vision&&vision.confidence>=45?JSON.stringify(vision):'(Vision/Text 타겟 확신 부족 또는 없음)';
  const d=await callOpenAI(accountId,
    `너는 한국 Threads 쇼핑 소재를 쿠팡파트너스 상품과 연결하는 편집자다. 실제 구매 가능한 상품을 식별한다. mode(recipe/product/lifestyle), topic, secretTerm, searchTerms, facts, hookStyle을 판단한다. searchTerms는 최대 2개이며 반드시 쿠팡에서 구매 가능한 구체적인 물건/식품/소스명이어야 한다. '운동','다이어트','일상','레시피' 같은 추상 주제어만 출력하면 안 된다. 작성자 댓글에 쇼핑 링크가 있다는 점을 고려해 무엇을 판매하는 글인지 최대한 구체적으로 추론하되 근거 없는 브랜드/모델은 만들지 않는다. JSON만 출력: {"mode":"recipe|product|lifestyle","topic":"","secretTerm":"","hideInBody":true,"searchTerms":[""],"facts":[""],"hookStyle":""}`,
    `타겟:${target||'전체'}\n[원 게시물]\n${m.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${m.authorReplies.slice(0,5000)||'(없음)'}\n[판매대상 검수]\n${visionText}`,
    {maxTokens:1200,temperature:.15}
  );
  let terms=[...new Set((Array.isArray(d.searchTerms)?d.searchTerms:[]).map(clean).filter(purchasableTerm))].slice(0,2);
  if(vision?.confidence>=55&&vision.searchTerms?.length){
    terms=[...new Set([...vision.searchTerms,...terms].map(clean).filter(purchasableTerm))].slice(0,2);
  }
  if(d.mode!=='recipe'&&vision?.confidence<55){
    const groundedTerms=terms.filter(t=>grounded(t,evidence));
    if(groundedTerms.length)terms=groundedTerms;
  }
  return{mode:['recipe','product','lifestyle'].includes(d.mode)?d.mode:'lifestyle',topic:clean(d.topic)||vision?.soldObject||vision?.dish||'Threads 소재',secretTerm:clean(d.secretTerm)||vision?.promotedIngredient||'',hideInBody:d.mode==='recipe'?true:d.hideInBody!==false,searchTerms:terms,facts:Array.isArray(d.facts)?d.facts.map(clean).filter(Boolean).slice(0,10):[],hookStyle:clean(d.hookStyle),vision};
}
async function findProduct(accountId,terms){
  for(const term of(terms||[]).slice(0,2)){
    const p=await coupangApi.searchProducts(accountId,term,8);if(!p.length)continue;
    const tokens=clean(term).split(/\s+/).map(normalized).filter(x=>x.length>=2);
    const exact=p.find(x=>{const n=normalized(x.name);return tokens.length&&tokens.every(t=>n.includes(t));});
    return{product:exact||p[0],searchTerm:term};
  }
  return{product:null,searchTerm:null};
}
function scrubSecret(text,secret,product){
  let out=String(text||'').trim();
  for(const v of[secret,product]){const t=clean(v);if(t.length>=2)out=out.split(t).join('비밀 재료');}
  return out;
}
function hasIngredientHeading(text){return /(?:🥘|✅|▪|■)?\s*재료\s*[:：]?/i.test(String(text||''));}
function hasMethodHeading(text){return /(?:🍳|✅|▪|■)?\s*(?:만드는\s*법|조리\s*방법|만들기)\s*[:：]?/i.test(String(text||''));}
function normalizeRecipeHeadings(text){
  let out=String(text||'').trim();
  out=out.replace(/(?:🥘\s*)?재료\s*[:：]?/i,'🥘 재료');
  out=out.replace(/(?:🍳\s*)?(?:만드는\s*법|조리\s*방법|만들기)\s*[:：]?/i,'🍳 만드는 법');
  return out;
}
function normalizeThreadsLayout(text){return formatVoice(text);}
async function rewriteThreadsTone(accountId,text,{mode,material,comment=false,visualEvidence=''}){
  if(comment&&!String(text||'').trim())return '';
  return reviewSourceVoice(text,{mode,comment,sourceText:material?.sourceText,authorReplies:material?.authorReplies,visualEvidence},
    (system,user)=>callOpenAI(accountId,system,user,{maxTokens:1000,temperature:.15}));
}
async function repairRecipeComment(accountId,{commentLead,material,analysis,productName}){
  let fixed=normalizeRecipeHeadings(commentLead);
  if(hasIngredientHeading(fixed)&&hasMethodHeading(fixed))return fixed;
  try{
    const d=await callOpenAI(accountId,
      `레시피 댓글 포맷 교정기다. 기존 내용을 최대한 보존하면서 반드시 '🥘 재료' 섹션과 '🍳 만드는 법' 섹션을 둘 다 만든다. 실제로 따라할 수 있게 작성한다. 조리 단계는 짧고 자연스러운 반말로 쓴다. 음슴체와 존댓말은 금지한다. 쿠팡 상품명/브랜드명/정확한 비밀소스 이름은 쓰지 말고 핵심 제휴재료는 '비밀 소스' 또는 '비밀 재료'라고만 쓴다. 링크와 광고고지는 쓰지 않는다. JSON만 출력: {"commentLead":""}`,
      `[기존 댓글]\n${commentLead}\n\n[원문]\n${material.sourceText.slice(0,3500)}\n\n내부 비밀재료:${analysis.secretTerm||productName}`,
      {maxTokens:1800,temperature:.25}
    );
    fixed=normalizeRecipeHeadings(String(d.commentLead||''));
  }catch(e){console.warn(`[AutopilotV3][RECIPE REPAIR] AI 교정 실패: ${e.message}`);}
  if(!hasIngredientHeading(fixed)||!hasMethodHeading(fixed))throw new Error('원문에 근거한 레시피 댓글을 완성하지 못했습니다');
  return fixed;
}
async function generatePost(accountId,{material,analysis,product,target}){
  const productName=clean(product?.name);
  const d=await callOpenAI(accountId,
`너는 한국 Threads에서 실제 사람이 쓰는 쇼핑/레시피 글 편집자다. 원 Threads의 내용과 말맛을 중심으로 가볍게 편집한다.

${voiceGuide()}

[레시피]
- 본문 text는 원문 내용과 흐름을 살리고 필요한 상황 반응만 보탠다. 궁금증이나 후킹을 억지로 만들지 않는다.
- 정확한 제휴 소스/핵심재료 이름은 숨긴다.
- 본문 마지막에 댓글 유도 문구를 자동으로 붙이지 않는다.
- commentLead는 반드시 '🥘 재료'와 '🍳 만드는 법' 두 섹션으로 쓴다.
- 조리 단계도 짧은 반말로 쓴다. 음슴체/존댓말 금지.
- 쿠팡 연결 핵심재료는 '비밀 소스' 또는 '비밀 재료'라고만 쓴다.

[일반상품/생활]
- 본문 text는 원문 흐름을 유지한다. 확인된 상황을 살리는 한마디는 필요할 때만 추가한다.
- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.
- commentLead는 확인된 정보 하나를 자연스러운 반말 1~2문장으로 보충한다. 추가 정보가 없으면 빈 문자열로 둔다.

JSON만 출력:{"text":"본문","commentLead":"댓글"}`,
    `타겟:${target||'전체'}\n모드:${analysis.mode}\n주제:${analysis.topic}\n내부 전용 비밀재료(출력 금지):${analysis.secretTerm||productName}\n쿠팡 상품:${productName}\n판매대상:${analysis.vision?.soldObject||'-'} / 요리:${analysis.vision?.dish||'-'}\n[시각 근거]\n${analysis.vision?.evidence||'(없음)'}\n[Threads 원문]\n${material.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000)||'(없음)'}`,
    {maxTokens:2800,temperature:.65}
  );
  let text=normalizeThreadsLayout(d.text||''),commentLead=String(d.commentLead||'').trim();
  if(!text)throw new Error('Threads 소재 기반 본문 생성 결과가 비었습니다');
  if(analysis.mode==='recipe'){
    text=scrubSecret(text,analysis.secretTerm,productName);
    commentLead=scrubSecret(commentLead,analysis.secretTerm,productName);
    if(/🥘\s*재료|🍳\s*만드는 법/.test(text))text=text.replace(/\n?(?:🥘\s*재료|🍳\s*만드는 법)[\s\S]*$/,'').trim();
    commentLead=await repairRecipeComment(accountId,{commentLead,material,analysis,productName});
  }else{
    if(/✅\s*핵심만/.test(text))text=text.replace(/\n?✅\s*핵심만[\s\S]*$/,'').trim();
    commentLead=normalizeVoice(commentLead.replace(/^\s*✅?\s*핵심만\s*[:：]?\s*\n?/i,''));
    text=text.replace(/\{\{COUPANG_LINK\}\}/g,'').replace(/\n{3,}/g,'\n\n').trim();
  }
  text=await rewriteThreadsTone(accountId,text,{mode:analysis.mode,topic:analysis.topic,material,visualEvidence:analysis.vision?.evidence});
  if(analysis.mode!=='recipe' && commentLead){
    try{commentLead=await rewriteThreadsTone(accountId,commentLead,{mode:analysis.mode,topic:analysis.topic,material,comment:true,visualEvidence:analysis.vision?.evidence});}
    catch(e){if(e.code!=='CONTENT_STYLE_REJECTED')throw e;commentLead='';}
  }
  if(analysis.mode==='recipe')text=scrubSecret(text,analysis.secretTerm,productName);
  text=assertVoice(text,{mode:analysis.mode});
  console.log(`[AutopilotV3][SOURCE VOICE v2] text="${text.replace(/\n/g,' / ')}"`);
  return{text,commentLead};
}
async function buildThreadsFirstAutopilot(accountId,{target}){
  const materials=await collectQualifiedThreadsMaterials(6);
  let lastError=null;
  for(let idx=0;idx<materials.length;idx++){
    const material=materials[idx];
    try{
      console.log(`[AutopilotV3][TRY] ${idx+1}/${materials.length} @${material.username||'-'} source=${material.url}`);
      const vision=await identifyCommerceTarget(accountId,material);
      const analysis=await analyzeMaterial(accountId,material,target,vision);
      if(!analysis.searchTerms.length){
        lastError=new Error(`Threads 소재 "${analysis.topic}"에서 구매 가능한 상품 검색어를 찾지 못했습니다`);
        console.log(`[AutopilotV3][SKIP] ${lastError.message} → 다음 소재`);
        markUsedPost(material.url);
        continue;
      }
      console.log(`[AutopilotV3][COUPANG SEARCH] 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);
      const found=await findProduct(accountId,analysis.searchTerms);
      if(!found.product){
        lastError=new Error(`Threads 소재 기반 쿠팡 상품을 찾지 못했습니다: ${analysis.searchTerms.join(', ')}`);
        console.log(`[AutopilotV3][SKIP] ${lastError.message} → 다음 소재`);
        markUsedPost(material.url);
        continue;
      }
      const generated=await generatePost(accountId,{material,analysis,product:found.product,target});
      markUsedPost(material.url);
      console.log(`[AutopilotV3][SUCCESS] @${material.username||'-'} product="${found.product.name}" mode=${analysis.mode}`);
      return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceText:material.sourceText,authorReplies:material.authorReplies,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};
    }catch(e){
      lastError=e;
      console.warn(`[AutopilotV3][TRY FAIL] @${material.username||'-'} ${e.response?.data?.error?.message||e.message} → 다음 소재`);
      if(coupangApi.isRateLimitError?.(e))throw e;
      markUsedPost(material.url);
    }
  }
  throw new Error(`쇼핑 소재 ${materials.length}개를 검사했지만 발행 가능한 상품 연결에 실패했습니다${lastError?`: ${lastError.message}`:''}`);
}
module.exports={buildThreadsFirstAutopilot};

