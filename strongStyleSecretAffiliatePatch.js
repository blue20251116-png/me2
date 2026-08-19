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
  return /(소스|양념|드레싱|시즈닝|굴소스|간장|고추장|된장|쌈장|액젓|식초|마요|케첩|머스타드|불고기양념|갈비양념)/i.test(String(v || ''));
}
function productMatchesCandidate(productName, term, requireSauce){
  const name = normalize(productName);
  const tokens = clean(term).split(/\s+/).map(normalize).filter(x => x.length >= 2);
  if (requireSauce && !isSauceLike(productName)) return false;
  if (!tokens.length) return true;
  return tokens.some(t => name.includes(t)) || (requireSauce && isSauceLike(productName));
}
async function findSecretAffiliateProduct(accountId, result){
  const comment = String(result?.commentLead || '');
  const sauceRequested = /비밀\s*소스/i.test(comment) || isSauceLike(result?.secretTerm) || isSauceLike(result?.visionTarget?.promotedIngredient);
  const candidates = [];
  const push = v => { const t = clean(v); if (t && !isGenericSecret(t) && !candidates.includes(t)) candidates.push(t); };
  push(result?.secretTerm);
  push(result?.visionTarget?.promotedIngredient);
  if (sauceRequested && clean(result?.topic)) push(`${clean(result.topic)} 소스`);

  for (const term of candidates.slice(0, 3)) {
    try {
      const products = await coupangApi.searchProducts(accountId, term, 10);
      if (!Array.isArray(products) || !products.length) continue;
      const requireSauce = sauceRequested || isSauceLike(term);
      const selected = products.find(p => productMatchesCandidate(p?.name, term, requireSauce));
      if (!selected) {
        console.log(`[AutopilotV3][SECRET AFFILIATE] 검색=${term} 결과는 있으나 비밀재료 조건 불일치 → 다음 후보`);
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

function appendSecretAffiliateBridge(commentLead, secretTerm){
  const term = clean(secretTerm);
  if (!term || isGenericSecret(term)) return stripTerminalPeriods(commentLead);

  const base = stripTerminalPeriods(commentLead)
    .replace(new RegExp(`\\n*여기\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+살짝[\\s\\S]*$`, 'i'), '')
    .trim();

  const bridge = `여기 ${term} 살짝 더해봐\n이게 진짜 킥이야ㅋㅋ`;
  return [base, bridge].filter(Boolean).join('\n\n').trim();
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
      result.commentLead = appendSecretAffiliateBridge(result.commentLead, replacement.searchTerm);
      console.log(`[AutopilotV3][SECRET AFFILIATE] 댓글 연결문 추가 term="${replacement.searchTerm}"`);
    } else {
      console.warn(`[AutopilotV3][SECRET AFFILIATE] 비밀재료용 적합 상품을 못 찾아 기존 상품 유지 topic="${clean(result.topic)}"`);
    }
  }
  return result;
};

console.log('[Autopilot][STRONG STYLE+SECRET AFFILIATE] 종결 마침표 제거 + 레시피 비밀재료 쿠팡 우선연결 + 자연스러운 링크 연결문 활성화');
