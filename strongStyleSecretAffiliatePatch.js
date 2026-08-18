const engine = require('./autopilotMaterialEngine');
const coupangApi = require('./coupangApi');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v || '').replace(/\s+/g, ' ').trim(); }
function normalize(v){ return clean(v).toLowerCase().replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g, ''); }
function stripTerminalPeriods(text){
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\.\s*$/g, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function isGenericSecret(v){
  const t = clean(v);
  if (!t) return true;
  return /^(비밀\s*(?:소스|재료|양념)|소스|양념|재료|핵심\s*재료)$/i.test(t);
}
function isSauceLike(v){
  return /(소스|양념|드레싱|시즈닝|굴소스|간장|고추장|된장|쌈장|액젓|식초|마요|케첩|머스타드|불고기양념|갈비양념|쯔유|참치액|치킨스톡|연두|맛술|미림)/i.test(String(v || ''));
}
const ALIASES=[
  ['마요네즈','마요'],['굴소스','오이스터소스'],['쯔유','츠유','메밀장국'],['참치액','참치액젓'],
  ['치킨스톡','치킨스톡분말','치킨스톡큐브'],['맛술','미림','요리술'],['베이킹파우더','베이킹 파우더'],
  ['고추장'],['된장'],['쌈장'],['케첩','토마토케첩'],['머스타드','겨자소스'],['식초']
];
function aliasTerms(term){
  const n=normalize(term);
  const out=[clean(term)];
  for(const group of ALIASES){
    if(group.some(x=>{const a=normalize(x);return n===a||n.includes(a)||a.includes(n);})){out.push(...group);}
  }
  return [...new Set(out.map(clean).filter(Boolean))];
}
function meaningfulTokens(term){
  return clean(term)
    .replace(/\b\d+(?:\.\d+)?\s*(?:g|kg|ml|l|개|병|팩|봉|입|큰술|작은술)\b/gi,' ')
    .split(/\s+/)
    .map(normalize)
    .filter(Boolean)
    .filter(t=>!['소스','양념','드레싱','시즈닝','파우더','분말','가루','오리지널','저당'].includes(t));
}
function productMatchesCandidate(productName, term, requireSauce){
  const name=normalize(productName);
  if(!name)return false;
  if(requireSauce&&!isSauceLike(productName)&&!aliasTerms(term).some(a=>name.includes(normalize(a))))return false;

  // 가장 안전한 조건: 실제 비밀재료명 또는 허용 동의어가 상품명에 들어가야 한다.
  if(aliasTerms(term).some(a=>{const n=normalize(a);return n.length>=2&&name.includes(n);})){return true;}

  // 복합 검색어라면 '소스/파우더' 같은 일반단어가 아니라 핵심 토큰 전체가 일치해야 한다.
  const tokens=meaningfulTokens(term);
  if(!tokens.length)return false;
  return tokens.every(t=>name.includes(t));
}
async function findSecretAffiliateProduct(accountId, result){
  const comment = String(result?.commentLead || '');
  const sauceRequested = /비밀\s*소스/i.test(comment) || isSauceLike(result?.secretTerm) || isSauceLike(result?.visionTarget?.promotedIngredient);
  const candidates = [];
  const push = v => { const t = clean(v); if (t && !isGenericSecret(t) && !candidates.includes(t)) candidates.push(t); };
  push(result?.secretTerm);
  push(result?.visionTarget?.promotedIngredient);

  // 음식명 + '소스'를 임의 생성하지 않는다. 원문에 실제 등장한 비밀재료만 허용한다.
  for (const term of candidates.slice(0, 3)) {
    try {
      const products = await coupangApi.searchProducts(accountId, term, 10);
      if (!Array.isArray(products) || !products.length) continue;
      const requireSauce = sauceRequested || isSauceLike(term);
      const selected = products.find(p => productMatchesCandidate(p?.name, term, requireSauce));
      if (!selected) {
        console.log(`[AutopilotV3][SECRET AFFILIATE CHECK] term="${term}" → REJECT all results (정확 재료명 불일치)`);
        continue;
      }
      console.log(`[AutopilotV3][SECRET AFFILIATE] 연결 성공 term="${term}" product="${clean(selected.name)}"`);
      return { product: selected, searchTerm: term };
    } catch (e) {
      console.warn(`[AutopilotV3][SECRET AFFILIATE] 검색 실패 term="${term}" reason="${e.response?.data?.message || e.message}"`);
      if (coupangApi.isRateLimitError?.(e)) throw e;
    }
  }
  return null;
}

engine.buildThreadsFirstAutopilot = async function strongStyleSecretAffiliateBuild(accountId, options){
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  result.text = stripTerminalPeriods(result.text);
  result.commentLead = stripTerminalPeriods(result.commentLead);

  if (result.mode === 'recipe') {
    const replacement = await findSecretAffiliateProduct(accountId, result);
    if (replacement?.product) {
      result.product = replacement.product;
      result.productSearchTerm = replacement.searchTerm;
      result.secretTerm = replacement.searchTerm;
    } else {
      // 엉뚱한 쿠팡 상품을 붙이는 것보다 해당 자동발행을 중단한다.
      const e=new Error(`비밀재료 쿠팡 상품 정확매칭 실패: ${clean(result.secretTerm||result.visionTarget?.promotedIngredient||result.topic)}`);
      e.code='SECRET_AFFILIATE_MISMATCH';
      console.warn(`[AutopilotV3][SECRET AFFILIATE] 정확매칭 실패 → 잘못된 링크 발행 차단 topic="${clean(result.topic)}"`);
      throw e;
    }
  }
  return result;
};

console.log('[Autopilot][STRONG STYLE+SECRET AFFILIATE] 종결 마침표 제거 + 비밀재료 정확매칭 + 오매칭 발행차단 활성화');
