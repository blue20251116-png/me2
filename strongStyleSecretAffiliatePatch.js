const engine = require('./autopilotMaterialEngine');
const coupangApi = require('./coupangApi');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v || '').replace(/\s+/g, ' ').trim(); }
function normalize(v){ return clean(v).toLowerCase().replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g, ''); }
function stripTerminalPeriods(text){
  return String(text || '').replace(/\r/g, '').split('\n').map(line => line.replace(/\.\s*$/g, '').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function isGenericSecret(v){ const t=clean(v); return !t || /^(비밀\s*(?:소스|재료|양념)|소스|양념|재료|핵심\s*재료)$/i.test(t); }
function isSauceLike(v){ return /(소스|양념|드레싱|시즈닝|굴소스|간장|고추장|된장|쌈장|액젓|식초|마요|케첩|머스타드|불고기양념|갈비양념|쯔유|참치액|치킨스톡|연두|맛술|미림)/i.test(String(v||'')); }
const ALIASES=[['마요네즈','마요'],['굴소스','오이스터소스'],['쯔유','츠유','메밀장국'],['참치액','참치액젓'],['치킨스톡','치킨스톡분말','치킨스톡큐브'],['맛술','미림','요리술'],['베이킹파우더','베이킹 파우더'],['고추장'],['된장'],['쌈장'],['케첩','토마토케첩'],['머스타드','겨자소스'],['식초']];
function aliasTerms(term){ const n=normalize(term),out=[clean(term)]; for(const group of ALIASES)if(group.some(x=>{const a=normalize(x);return n===a||n.includes(a)||a.includes(n);} ))out.push(...group); return [...new Set(out.map(clean).filter(Boolean))]; }
function meaningfulTokens(term){ return clean(term).replace(/\b\d+(?:\.\d+)?\s*(?:g|kg|ml|l|개|병|팩|봉|입|큰술|작은술)\b/gi,' ').split(/\s+/).map(normalize).filter(Boolean).filter(t=>!['소스','양념','드레싱','시즈닝','파우더','분말','가루','오리지널','저당'].includes(t)); }
function productMatchesCandidate(productName,term,requireSauce){ const name=normalize(productName); if(!name)return false; if(requireSauce&&!isSauceLike(productName)&&!aliasTerms(term).some(a=>name.includes(normalize(a))))return false; if(aliasTerms(term).some(a=>{const n=normalize(a);return n.length>=2&&name.includes(n);} ))return true; const tokens=meaningfulTokens(term); return !!tokens.length&&tokens.every(t=>name.includes(t)); }
function splitCandidateTerms(v){
  const raw=clean(v); if(!raw)return [];
  const parts=raw.split(/[,/·+]|\s+(?:및|그리고)\s+/).map(clean).filter(Boolean);
  return [...new Set((parts.length>1?parts:[raw]).filter(x=>!isGenericSecret(x)))];
}
function existingProductLooksUsable(result){
  const name=clean(result?.product?.name); if(!name)return false;
  const terms=[result?.productSearchTerm,result?.visionTarget?.promotedIngredient,...splitCandidateTerms(result?.secretTerm)].map(clean).filter(Boolean);
  return terms.some(t=>productMatchesCandidate(name,t,isSauceLike(t)));
}
async function findSecretAffiliateProduct(accountId,result){
  const comment=String(result?.commentLead||'');
  const sauceRequested=/비밀\s*소스/i.test(comment)||isSauceLike(result?.visionTarget?.promotedIngredient);
  const candidates=[]; const push=v=>{for(const t of splitCandidateTerms(v))if(!candidates.includes(t))candidates.push(t);};
  push(result?.visionTarget?.promotedIngredient); push(result?.productSearchTerm); push(result?.secretTerm);
  for(const term of candidates.slice(0,6)){
    try{
      const products=await coupangApi.searchProducts(accountId,term,10); if(!Array.isArray(products)||!products.length)continue;
      const requireSauce=sauceRequested&&isSauceLike(term);
      const selected=products.find(p=>productMatchesCandidate(p?.name,term,requireSauce));
      if(!selected){console.log(`[AutopilotV3][SECRET AFFILIATE CHECK] term="${term}" → REJECT all results`);continue;}
      console.log(`[AutopilotV3][SECRET AFFILIATE] 연결 성공 term="${term}" product="${clean(selected.name)}"`);
      return{product:selected,searchTerm:term};
    }catch(e){console.warn(`[AutopilotV3][SECRET AFFILIATE] 검색 실패 term="${term}" reason="${e.response?.data?.message||e.message}"`);if(coupangApi.isRateLimitError?.(e))throw e;}
  }
  return null;
}

engine.buildThreadsFirstAutopilot=async function strongStyleSecretAffiliateBuild(accountId,options){
  const result=await originalBuild(accountId,options); if(!result)return result;
  result.text=stripTerminalPeriods(result.text); result.commentLead=stripTerminalPeriods(result.commentLead);
  if(result.mode==='recipe'){
    if(result.originalSellerProduct?.url){console.log(`[AutopilotV3][SECRET AFFILIATE] 원작성자 선택상품 우선 → 추가 검색 생략 product="${clean(result.product?.name)}"`);return result;}
    // 앞 단계가 이미 쿠팡에서 정상 상품을 찾았다면 다시 '모든 재료 정확일치' 검증으로 실패시키지 않는다.
    if(existingProductLooksUsable(result)){
      console.log(`[AutopilotV3][SECRET AFFILIATE] 기존 검색상품 재사용 product="${clean(result.product?.name)}" term="${clean(result.productSearchTerm)}"`);
      if(result.productSearchTerm)result.secretTerm=result.productSearchTerm;
      return result;
    }
    const replacement=await findSecretAffiliateProduct(accountId,result);
    if(replacement?.product){result.product=replacement.product;result.productSearchTerm=replacement.searchTerm;result.secretTerm=replacement.searchTerm;}
    else if(result?.product?.name){
      // 소재 자체는 버리지 않는다. 앞 단계 상품이 존재하면 안전 fallback으로 유지한다.
      console.log(`[AutopilotV3][SECRET AFFILIATE FALLBACK] 정확매칭 추가검색 실패 → 기존 상품 유지 product="${clean(result.product.name)}"`);
    }else{
      const e=new Error(`비밀재료 쿠팡 상품 매칭 실패: ${clean(result.secretTerm||result.visionTarget?.promotedIngredient||result.topic)}`); e.code='SECRET_AFFILIATE_MISMATCH'; throw e;
    }
  }
  return result;
};
console.log('[Autopilot][STRONG STYLE+SECRET AFFILIATE V2] 원작성자 상품 우선 + 기존 성공상품 재사용 + 복수재료 분리검색 + 소재보존');
