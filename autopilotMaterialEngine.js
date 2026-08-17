const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const { collectBenchmarkMaterials, collectPostDetails, markUsedPost } = require('./benchmarkAccounts');
const coupangApi = require('./coupangApi');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}
async function callOpenAI(accountId, system, user, { maxTokens = 1800, temperature = 0.55 } = {}) {
  const apiKey = getOpenAIKey(accountId); if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const res = await axios.post('https://api.openai.com/v1/chat/completions', { model:'gpt-4o-mini',temperature,max_tokens:maxTokens,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:user}] }, {headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:45000});
  const raw=res.data?.choices?.[0]?.message?.content; if(!raw) throw new Error('AI 결과가 비어 있습니다'); return JSON.parse(raw);
}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function normalized(v){return clean(v).toLowerCase().replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g,'');}
function hasExternalLink(t){return /(?:https?:\/\/|www\.)\S+/i.test(String(t||''))||/\b(?:link\.coupang\.com|naver\.me)\b/i.test(String(t||''));}
function materialScore(item){const text=clean(item?.text);let s=0;if(item?.hasVideo||Number(item?.videoCount||0)>0)s+=3;if(Number(item?.imageCount||0)>0||(Array.isArray(item?.images)&&item.images.length))s+=2;if(text.length>=40&&text.length<=1000)s+=4;else if(text.length>=20)s+=2;if(/(레시피|소스|양념|재료|만드는|볶|굽|끓|에어프라이어|큰술|스푼|\bT\b)/i.test(text))s+=5;if(/(비밀|핵심|이거|댓글|진짜|ㅋㅋ|꿀템|사버|추천)/i.test(text))s+=2;if(hasExternalLink(text))s-=30;return s+Math.random();}
async function pickThreadsMaterial(){const m=await collectBenchmarkMaterials({limit:12});const u=(m||[]).filter(x=>x?.url&&clean(x.text).length>=12&&!hasExternalLink(x.text));if(!u.length)throw new Error('Threads에서 사용할 소재를 찾지 못했습니다');u.sort((a,b)=>materialScore(b)-materialScore(a));return u[0];}
async function enrichThreadsMaterial(item){let sourceText=clean(item?.text),authorReplies='';let images=Array.isArray(item?.images)?item.images.filter(Boolean):[],videos=[];if(item?.url&&item?.username){try{const d=await collectPostDetails(item.url,item.username);if(clean(d?.sourceText).length>=8)sourceText=clean(d.sourceText);authorReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean).join('\n\n'):'';if(Array.isArray(d?.images)&&d.images.length)images=d.images.filter(Boolean);if(Array.isArray(d?.videos))videos=d.videos.filter(Boolean);}catch(err){console.log(`[AutopilotV3][Threads detail] 상세 수집 실패, 목록 소재 사용: ${err.message}`);}}return{...item,sourceText,authorReplies,images,videos};}
function grounded(term,evidence){const t=normalized(term),e=normalized(evidence);if(!t||!e)return false;if(e.includes(t))return true;const tokens=clean(term).split(/\s+/).map(normalized).filter(x=>x.length>=2);return tokens.length>0&&tokens.every(x=>e.includes(x));}
async function analyzeMaterial(accountId,material,target){const evidence=`${material.sourceText}\n${material.authorReplies}`;const data=await callOpenAI(accountId,`너는 한국 Threads 소재를 쿠팡파트너스 상품과 연결하는 편집자다. Threads 소재가 무조건 먼저다. 원 게시물과 작성자 추가댓글을 사실 자료로 읽고 mode(recipe/product/lifestyle), topic, secretTerm, searchTerms, facts, hookStyle을 판단한다. searchTerms는 원문/작성자댓글에 실제 근거가 있는 상품·재료·소스·도구만 허용한다. 레시피에서 비밀 소스나 핵심 재료가 있으면 최우선 상품으로 잡는다. JSON만 출력: {"mode":"recipe|product|lifestyle","topic":"","secretTerm":"","hideInBody":true,"searchTerms":[""],"facts":[""],"hookStyle":""}`,`타겟: ${target||'전체'}\n[원 게시물]\n${material.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000)||'(없음)'}`,{maxTokens:1000,temperature:0.12});const terms=[...new Set((Array.isArray(data.searchTerms)?data.searchTerms:[]).map(clean).filter(Boolean))].filter(t=>grounded(t,evidence)).slice(0,3);const secret=clean(data.secretTerm);return{mode:['recipe','product','lifestyle'].includes(data.mode)?data.mode:'lifestyle',topic:clean(data.topic)||'Threads 소재',secretTerm:secret&&grounded(secret,evidence)?secret:'',hideInBody:data.mode==='recipe'?true:data.hideInBody!==false,searchTerms:terms,facts:Array.isArray(data.facts)?data.facts.map(clean).filter(Boolean).slice(0,10):[],hookStyle:clean(data.hookStyle)};}
async function findProduct(accountId,terms){for(const term of(terms||[]).slice(0,3)){const products=await coupangApi.searchProducts(accountId,term,8);if(!products.length)continue;const tokens=clean(term).split(/\s+/).map(normalized).filter(x=>x.length>=2);const exactish=products.find(p=>{const n=normalized(p.name);return tokens.length>0&&tokens.every(t=>n.includes(t));});return{product:exactish||products[0],searchTerm:term};}return{product:null,searchTerm:null};}
function scrubSecret(text,secretTerm,productName){let out=String(text||'').trim();for(const v of[secretTerm,productName]){const term=clean(v);if(term.length>=2)out=out.split(term).join('비밀 재료');}return out;}
async function generatePost(accountId,{material,analysis,product,target}){const productName=clean(product?.name);const data=await callOpenAI(accountId,`너는 한국 Threads 글 편집자다. 반드시 제공된 Threads 소재를 중심으로 새 글을 쓴다. 쿠팡 상품을 먼저 홍보하는 광고글로 바꾸면 안 된다.
공통: 원문 문장 복사 금지. 원문/작성자댓글에 없는 경험·효능·수치·재료·조리시간을 창작하지 않는다. 자연스러운 반말과 짧은 줄을 사용하고 음슴체는 금지한다.

[레시피 모드 필수 포맷]
후킹 1~2줄

🥘 재료
- 원문/작성자댓글에서 확인되는 재료들을 목록으로 작성
- secretTerm 또는 쿠팡으로 연결할 핵심 재료/소스는 정확한 이름을 쓰지 말고 '비밀 소스' 또는 '비밀 재료'로 표시

🍳 만드는 법
1. 원문에서 확인되는 첫 번째 조리 단계
2. 원문에서 확인되는 다음 조리 단계
3. 필요한 만큼 순서대로 계속

짧은 마무리
비밀 소스(또는 비밀 재료)는 댓글에 남겨둘게

레시피 규칙:
- 재료 목록과 만드는 법은 반드시 둘 다 있어야 한다. 하나라도 빠지면 안 된다.
- 재료의 양, 온도, 시간은 원문/작성자댓글에 실제로 있을 때만 적는다.
- 원문에 없는 재료나 조리 단계를 상식으로 임의 추가하지 않는다.
- 핵심 쿠팡 상품의 정확한 이름은 본문에서 절대 공개하지 않는다.
- 레시피 본문에는 링크와 광고고지를 넣지 않는다.
- commentLead에는 숨긴 비밀 재료의 정체를 공개하는 짧은 문구만 생성한다.

[일반상품/생활 고정 포맷]
후킹 한두 줄

{{COUPANG_LINK}}

✅ 핵심만
- 원문에서 확인되는 핵심 포인트
- 원문에서 확인되는 핵심 포인트
- 필요하면 세 번째 포인트

짧은 마무리 한 줄

일반상품 규칙: 광고고지는 시스템이 맨 위에 붙인다. {{COUPANG_LINK}}는 반드시 '✅ 핵심만' 바로 위에 둔다. '내가 본 건','내가 산 건','써봤는데','사용해보니','직접 써보니까' 등 확인되지 않은 경험 표현 금지. 제품/생활은 commentLead를 빈 문자열로 출력한다.
JSON만 출력: {"text":"본문","commentLead":""}`,`타겟: ${target||'전체'}\n모드: ${analysis.mode}\n주제: ${analysis.topic}\n숨길 핵심어: ${analysis.secretTerm||'(없음)'}\n쿠팡 연결 상품: ${productName||'(없음)'}\n[Threads 원문]\n${material.sourceText.slice(0,5000)}\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000)||'(없음)'}`,{maxTokens:2000,temperature:0.6});let text=String(data.text||'').trim();if(!text)throw new Error('Threads 소재 기반 본문 생성 결과가 비었습니다');if(analysis.mode==='recipe'){text=scrubSecret(text,analysis.secretTerm,productName);if(!/🥘\s*재료/.test(text)||!/🍳\s*만드는 법/.test(text))throw new Error('레시피 생성 결과에 재료 또는 만드는 법이 누락되었습니다');}if(analysis.mode!=='recipe'&&!text.includes('{{COUPANG_LINK}}')){const marker='✅ 핵심만';text=text.includes(marker)?text.replace(marker,`{{COUPANG_LINK}}\n\n${marker}`):`${text}\n\n{{COUPANG_LINK}}\n\n✅ 핵심만`;}let commentLead='';if(analysis.mode==='recipe')commentLead=String(data.commentLead||'').trim()||`본문에서 말한 비밀 재료는 이거야 👇\n${productName}`;return{text,commentLead};}
async function buildThreadsFirstAutopilot(accountId,{target}){const picked=await pickThreadsMaterial();const material=await enrichThreadsMaterial(picked);const analysis=await analyzeMaterial(accountId,material,target);if(!analysis.searchTerms.length){markUsedPost(material.url);throw new Error(`Threads 소재 "${analysis.topic}"에서 쿠팡으로 연결할 구체적 상품을 찾지 못했습니다`);}const found=await findProduct(accountId,analysis.searchTerms);if(!found.product){markUsedPost(material.url);throw new Error(`Threads 소재 기반 쿠팡 상품을 찾지 못했습니다: ${analysis.searchTerms.join(', ')}`);}const generated=await generatePost(accountId,{material,analysis,product:found.product,target});markUsedPost(material.url);return{text:generated.text,commentLead:generated.commentLead,product:found.product,productSearchTerm:found.searchTerm,mode:analysis.mode,topic:analysis.topic,secretTerm:analysis.secretTerm,sourceUrl:material.url,sourceUsername:material.username||null,referenceImage:material.images?.[0]||null};}
module.exports={buildThreadsFirstAutopilot};
