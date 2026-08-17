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
  if(i?.hasVideo||Number(i?.videoCount||0)>0)s+=3;
  if(Number(i?.imageCount||0)>0||(Array.isArray(i?.images)&&i.images.length))s+=2;
  if(t.length>=40&&t.length<=1000)s+=4;else if(t.length>=20)s+=2;
  if(/(레시피|소스|양념|재료|만드는|볶|굽|끓|에어프라이어|큰술|스푼|\bT\b)/i.test(t))s+=5;
  if(/(비밀|핵심|이거|댓글|진짜|ㅋㅋ|꿀템|사버|추천)/i.test(t))s+=2;
  if(hasExternalLink(t))s-=30;
  return s+Math.random();
}
async function pickThreadsMaterials(){
  const m=await collectBenchmarkMaterials({limit:36});
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
async function pickQualifiedThreadsMaterial(){
  const candidates=await pickThreadsMaterials();
  let lastError=null;
  for(const candidate of candidates.slice(0,24)){
    try{
      const material=await enrichThreadsMaterial(candidate);
      console.log(`[AutopilotV3][Material] 채택 @${material.username||'-'} 작성자 쇼핑링크 확인 source=${material.url}`);
      return material;
    }catch(e){
      lastError=e;
      console.log(`[AutopilotV3][Material] 제외 @${candidate.username||'-'} reason="${e.message}" source=${candidate.url}`);
      markUsedPost(candidate.url);
    }
  }
  throw new Error(`조건에 맞는 소재를 찾지 못했습니다${lastError?`: ${lastError.message}`:''}`);
}
function grounded(term,evidence){
  const t=normalized(term),e=normalized(evidence);if(!t||!e)return false;
  if(e.includes(t))return true;
  const tokens=clean(term).split(/\s+/).map(normalized).filter(x=>x.length>=2);
  return tokens.length>0&&tokens.every(x=>e.includes(x));
}
async function identifyCommerceTarget(accountId,m){
  const images=(Array.isArray(m.images)?m.images:[]).filter(Boolean).slice(0,3);
  try{
    const d=await callOpenAIVision(accountId,
`너는 Threads 쇼핑 소재의 '실제로 판매/추천하는 대상'을 식별하는 검수자다. 본문·작성자 댓글·대표 이미지/영상 커버 장면을 함께 보고 판단한다.
가장 중요한 규칙:
- 화면에 보인다고 판매 대상이라고 단정하지 않는다. 본문에서 무엇을 칭찬/추천/구매유도하는지와 시각정보를 교차검증한다.
- 예: 커피가 텀블러 안에 보여도 글이 보온, 뚜껑, 휴대성을 말하면 판매 대상은 '텀블러'다. 반대로 원두/맛/향/카페인/커피 자체를 말하면 판매 대상은 '커피'다.
- 음식 사진이면 완성요리 자체와 제휴하려는 핵심 재료/소스/조미료를 구분한다. 요리명은 dish, 실제 쿠팡에서 찾을 대상은 soldObject/searchTerms에 둔다.
- 주변 소품(접시, 컵, 냄비, 휴대폰, 배경 가구)을 판매 대상으로 착각하지 않는다.
- 브랜드/정확한 모델명은 화면이나 글에 명확한 근거가 있을 때만 쓴다. 근거 없으면 일반 카테고리명으로 쓴다.
- searchTerms는 쿠팡 API를 아끼기 위해 가장 정확한 검색어 최대 2개만 만든다. 1순위는 구체적이되 과도한 모델 추측은 금지한다.
JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","searchTerms":[""],"confidence":0,"evidence":""}`,
`[Threads 본문]\n${m.sourceText.slice(0,4500)}\n\n[작성자 댓글]\n${m.authorReplies.slice(0,3500)||'(없음)'}\n\n대표 시각자료 ${images.length}장. 영상 소재는 수집된 대표 이미지/커버 장면을 시각 근거로 사용하라.`,
      images,{maxTokens:1200,temperature:.1});
    const result={
      kind:['product','food','recipe','lifestyle'].includes(d.kind)?d.kind:'product',
      soldObject:clean(d.soldObject),
      dish:clean(d.dish),
      promotedIngredient:clean(d.promotedIngredient),
      searchTerms:[...new Set((Array.isArray(d.searchTerms)?d.searchTerms:[]).map(clean).filter(Boolean))].slice(0,2),
      confidence:Math.max(0,Math.min(100,Number(d.confidence)||0)),
      evidence:clean(d.evidence).slice(0,300)
    };
    console.log(`[AutopilotV3][VISION TARGET] kind=${result.kind} sold="${result.soldObject||'-'}" dish="${result.dish||'-'}" ingredient="${result.promotedIngredient||'-'}" confidence=${result.confidence} terms="${result.searchTerms.join(' / ')}"`);
    return result;
  }catch(e){
    console.warn(`[AutopilotV3][VISION TARGET] 실패 → 텍스트 분석만 사용: ${e.message}`);
    return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};
  }
}
async function analyzeMaterial(accountId,m,target,vision){
  const evidence=`${m.sourceText}\n${m.authorReplies}`;
  const visionText=vision&&vision.confidence>=55?JSON.stringify(vision):'(Vision 확신 부족 또는 없음)';
  const d=await callOpenAI(accountId,
    `너는 한국 Threads 소재를 쿠팡파트너스 상품과 연결하는 편집자다. Threads 소재가 무조건 먼저다. 본문/작성자댓글과 Vision 검수 결과를 교차검증해 실제 판매 대상을 정한다. 화면에 등장한 물건과 판매하는 물건을 혼동하지 않는다. 특히 '커피가 담긴 텀블러'처럼 내용물과 용기가 함께 있으면 본문이 어떤 기능/효과를 강조하는지로 판매 대상을 확정한다. mode(recipe/product/lifestyle), topic, secretTerm, searchTerms, facts, hookStyle을 판단한다. 레시피는 완성요리와 제휴 핵심재료를 구분한다. Vision confidence가 70 이상이면 그 soldObject/searchTerms를 강하게 우선하되 본문과 명백히 모순되면 본문을 우선한다. 쿠팡 검색어는 최대 2개만 출력한다. 브랜드/모델은 근거가 있을 때만 쓴다. 억지 상품 연결 금지. JSON만 출력: {"mode":"recipe|product|lifestyle","topic":"","secretTerm":"","hideInBody":true,"searchTerms":[""],"facts":[""],"hookStyle":""}`,
    `타겟:${target||'전체'}\n[원 게시물]\n${m.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${m.authorReplies.slice(0,5000)||'(없음)'}\n[Vision 판매대상 검수]\n${visionText}`,
    {maxTokens:1200,temperature:.15}
  );
  let terms=[...new Set((Array.isArray(d.searchTerms)?d.searchTerms:[]).map(clean).filter(Boolean))].slice(0,2);
  if(vision?.confidence>=70&&vision.searchTerms?.length){
    terms=[...new Set([...vision.searchTerms,...terms].map(clean).filter(Boolean))].slice(0,2);
  }else if(d.mode!=='recipe'){
    terms=terms.filter(t=>grounded(t,evidence));
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
async function generatePost(accountId,{material,analysis,product,target}){
  const productName=clean(product?.name);
  const d=await callOpenAI(accountId,
`너는 한국 Threads 글 편집자다. Threads 소재를 중심으로 새 글을 쓴다. 원문 문장 복사는 금지한다. 확인되지 않은 개인 경험을 만들지 않는다.
[레시피]
본문 text는 3~7줄의 짧은 후킹글이다. 요리 핵심 장면을 보여주고 정확한 제휴 소스/핵심재료 이름은 숨긴다. 끝에는 재료와 만드는 법을 댓글에서 보게 자연스럽게 유도한다.
commentLead에는 실제 따라할 수 있는 레시피를 작성한다: 🥘 재료 + 🍳 만드는 법. 원문에 부족한 일반적인 재료/단계는 요리가 실제로 성립하도록 합리적으로 보완할 수 있다. 쿠팡 연결 핵심재료는 '비밀 소스' 또는 '비밀 재료'라고만 쓴다. commentLead 어디에도 secretTerm, 쿠팡 상품명, 브랜드명, 정확한 비밀소스 이름을 적지 않는다. 링크와 광고고지도 쓰지 않는다.
[일반상품/생활]
본문 text에는 Threads 소재 기반의 짧고 자연스러운 후킹/상황 글만 쓴다. 제품 스펙 목록, '✅ 핵심만', 쿠팡 링크, 광고고지, 상품명 나열을 본문에 넣지 않는다. 마지막에는 댓글을 보라고 억지로 유도하지 않아도 된다. 확인되지 않은 '내가 본 건/내가 산 건/써봤는데/사용해보니' 금지.
commentLead에는 반드시 다음 형식으로 제품 핵심 정보를 작성한다:
✅ 핵심만
- 원문에서 확인되는 핵심 포인트 1
- 원문에서 확인되는 핵심 포인트 2
- 필요하면 핵심 포인트 3
링크와 광고고지는 commentLead에 쓰지 않는다. 시스템이 commentLead 아래에 동일 쿠파스 링크 2개와 고지문을 자동으로 붙인다.
JSON만 출력:{"text":"본문","commentLead":"댓글"}`,
    `타겟:${target||'전체'}\n모드:${analysis.mode}\n주제:${analysis.topic}\n내부 전용 비밀재료(출력 금지):${analysis.secretTerm||productName}\n쿠팡 상품:${productName}\nVision 확인 대상:${analysis.vision?.soldObject||'-'} / 요리:${analysis.vision?.dish||'-'}\n[Threads 원문]\n${material.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000)||'(없음)'}`,
    {maxTokens:2800,temperature:.58}
  );
  let text=String(d.text||'').trim(),commentLead=String(d.commentLead||'').trim();
  if(!text)throw new Error('Threads 소재 기반 본문 생성 결과가 비었습니다');
  if(analysis.mode==='recipe'){
    text=scrubSecret(text,analysis.secretTerm,productName);commentLead=scrubSecret(commentLead,analysis.secretTerm,productName);
    if(/🥘\s*재료|🍳\s*만드는 법/.test(text))throw new Error('레시피 본문에 재료/만드는 법이 들어갔습니다');
    if(!/🥘\s*재료/.test(commentLead)||!/🍳\s*만드는 법/.test(commentLead))throw new Error('레시피 댓글에 재료 또는 만드는 법이 누락되었습니다');
  }else{
    if(/✅\s*핵심만/.test(text))throw new Error('일반상품 본문에 핵심만 섹션이 들어갔습니다');
    if(!/✅\s*핵심만/.test(commentLead))throw new Error('일반상품 댓글에 핵심만 섹션이 누락되었습니다');
    text=text.replace(/\{\{COUPANG_LINK\}\}/g,'').replace(/\n{3,}/g,'\n\n').trim();
  }
  return{text,commentLead};
}
async function buildThreadsFirstAutopilot(accountId,{target}){
  const material=await pickQualifiedThreadsMaterial();
  const vision=await identifyCommerceTarget(accountId,material);
  const analysis=await analyzeMaterial(accountId,material,target,vision);
  if(!analysis.searchTerms.length){markUsedPost(material.url);throw new Error(`Threads 소재 "${analysis.topic}"에서 쿠팡으로 연결할 상품 후보를 찾지 못했습니다`);}
  console.log(`[AutopilotV3][COUPANG SEARCH] 최종 검색어=${analysis.searchTerms.join(' / ')} (최대 2회)`);
  const found=await findProduct(accountId,analysis.searchTerms);
  if(!found.product){markUsedPost(material.url);throw new Error(`Threads 소재 기반 쿠팡 상품을 찾지 못했습니다: ${analysis.searchTerms.join(', ')}`);}
  const generated=await generatePost(accountId,{material,analysis,product:found.product,target});
  markUsedPost(material.url);
  return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,sourceImages:Array.isArray(material.images)?material.images.filter(Boolean).slice(0,10):[],sourceVideos:Array.isArray(material.videos)?material.videos.filter(Boolean).slice(0,5):[],referenceImage:material.images?.[0]||null,visionTarget:vision};
}
module.exports={buildThreadsFirstAutopilot};