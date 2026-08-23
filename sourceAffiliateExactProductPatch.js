const axios = require('axios');
const { collectPostDetails } = require('./benchmarkAccounts');
const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}
function isBlockedTitle(v) {
  const t=clean(v).toLowerCase();
  return !t || /access denied|forbidden|robot check|captcha|쿠팡 로그인|로그인이 필요|페이지를 찾을 수 없|요청하신 페이지|error 403|403 forbidden/i.test(t);
}
function safeTitle(v){const t=clean(v);return isBlockedTitle(t)?'':t;}

function extractCoupangLinks(authorReplies) {
  const text = Array.isArray(authorReplies) ? authorReplies.join('\n\n') : String(authorReplies || '');
  const matches = text.match(/https?:\/\/(?:link\.)?coupang\.com\/[^\s<>'"\])}>,]+|https?:\/\/www\.coupang\.com\/vp\/products\/\d+[^\s<>'"\])}>,]*/gi) || [];
  const out = [];
  for (let raw of matches) {
    raw = String(raw || '').replace(/[.,;:!?]+$/g, '').trim();
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out.slice(0, 4);
}

function decodeHtml(v) {
  return String(v || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html) {
  const s = String(html || '');
  const og = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og?.[1]) return safeTitle(decodeHtml(og[1]).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim());
  const t = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t?.[1] ? safeTitle(decodeHtml(t[1]).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim()) : '';
}

function productIdFrom(value) {
  const s = String(value || '');
  return s.match(/\/vp\/products\/(\d+)/i)?.[1]
    || s.match(/[?&]productId=(\d+)/i)?.[1]
    || null;
}

function canonicalProductUrl(finalUrl, html) {
  const id = productIdFrom(finalUrl) || productIdFrom(html);
  if (id) return { productId: id, url: `https://www.coupang.com/vp/products/${id}` };
  if (/^https?:\/\/(?:www\.)?coupang\.com\//i.test(String(finalUrl || ''))) {
    return { productId: null, url: String(finalUrl).split('#')[0] };
  }
  return null;
}

async function resolveWithAxios(sourceUrl) {
  const res = await axios.get(sourceUrl, {
    maxRedirects: 10,
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.7',
    },
    validateStatus: s => s >= 200 && s < 500,
    maxContentLength: 2 * 1024 * 1024,
  });
  const finalUrl = res?.request?.res?.responseUrl || res?.request?._redirectable?._currentUrl || sourceUrl;
  const html = typeof res.data === 'string' ? res.data : '';
  const canonical = canonicalProductUrl(finalUrl, html);
  if (!canonical) return null;
  return {
    sourceUrl,
    finalUrl,
    ...canonical,
    title: titleFromHtml(html),
    method: 'axios',
  };
}

async function resolveWithBrowser(sourceUrl) {
  let browser;
  try {
    const playwright = require('playwright');
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage({
      locale: 'ko-KR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(900);
    const finalUrl = page.url();
    const metaTitle = await page.locator('meta[property="og:title"]').getAttribute('content').catch(() => '');
    const pageTitle = await page.title().catch(() => '');
    const canonical = canonicalProductUrl(finalUrl, '');
    if (!canonical) return null;
    return {
      sourceUrl,
      finalUrl,
      ...canonical,
      title: safeTitle(clean(metaTitle || pageTitle).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim()),
      method: 'browser',
    };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

async function resolveSourceLink(sourceUrl) {
  try {
    const a = await resolveWithAxios(sourceUrl);
    if (a?.url) return a;
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] axios 해석 실패 url=${sourceUrl} reason="${e.message}"`);
  }
  try {
    const b = await resolveWithBrowser(sourceUrl);
    if (b?.url) return b;
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] browser 해석 실패 url=${sourceUrl} reason="${e.message}"`);
  }
  return null;
}

function normalize(v) {
  return clean(v)
    .toLowerCase()
    .replace(/muji/g, '무인양품')
    .replace(/[^0-9a-z가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_TOKENS = new Set([
  '정품','공식','국내','해외','직구','무료배송','로켓','배송','상품','제품','용품','세트','구성','옵션','선택',
  '1개','2개','3개','1팩','2팩','01','02','white','black','화이트','블랙','직장인','식단','용기'
]);

function tokens(v) {
  return normalize(v)
    .split(/\s+/)
    .filter(x => x.length >= 2 && !STOP_TOKENS.has(x));
}

function unique(arr){return [...new Set((arr||[]).filter(Boolean))];}

function matchReferenceToTitle(reference, title) {
  const r = normalize(reference);
  const t = normalize(title);
  if (!r || !t) return { ok:false, score:0, overlap:[], reason:'empty' };
  if (t.includes(r) || r.includes(t)) return { ok:true, score:100, overlap:tokens(reference), reason:'normalized-contains' };

  const rt = unique(tokens(reference));
  const tt = new Set(tokens(title));
  const overlap = rt.filter(x => tt.has(x) || t.includes(x));
  if (!rt.length) return { ok:false, score:0, overlap, reason:'no-reference-token' };

  const ratio = overlap.length / rt.length;
  const required = rt.length >= 4 ? 2 : rt.length >= 2 ? Math.min(2, rt.length) : 1;
  const ok = overlap.length >= required || (overlap.length >= 1 && ratio >= 0.6);
  return { ok, score:Math.round(ratio*100)+overlap.length*10, overlap, reason:ok?'token-match':'token-mismatch' };
}

function strictSourceProductMatch(candidate, result) {
  const title = safeTitle(candidate?.title);
  if (!title) return { ok:false, score:0, reason:'title-unavailable', reference:'' };

  const references = unique([
    clean(result?.visionTarget?.soldObject),
    clean(result?.topic),
    clean(result?.product?.name),
  ]).filter(Boolean);
  if (!references.length) return { ok:false, score:0, reason:'no-evidence', reference:'' };

  let best={ok:false,score:0,reason:'no-match',reference:'',overlap:[]};
  for(const reference of references){
    const m=matchReferenceToTitle(reference,title);
    if(m.score>best.score)best={...m,reference};
    if(m.ok && m.score>=best.score)best={...m,reference};
  }
  return best;
}

function candidateScore(candidate, detail, result, index) {
  const strict = strictSourceProductMatch(candidate, result);
  if (!strict.ok) return -1000 - index;
  return strict.score - index * 0.01;
}

async function findExactSourceProduct(result) {
  if (!result?.sourceUrl || !result?.sourceUsername) return null;
  const detail = await collectPostDetails(result.sourceUrl, result.sourceUsername);
  const links = extractCoupangLinks(detail?.authorReplies);
  if (!links.length) {
    console.log(`[AutopilotV3][SOURCE AFFILIATE] @${result.sourceUsername} 작성자 C사 링크 없음 → 기존 상품 유지`);
    return null;
  }
  console.log(`[AutopilotV3][SOURCE AFFILIATE] @${result.sourceUsername} 작성자 C사 링크 ${links.length}개 확인`);

  const resolved = [];
  for (let i = 0; i < links.length; i++) {
    const item = await resolveSourceLink(links[i]);
    if (!item?.url) continue;
    const strict = strictSourceProductMatch(item, result);
    if (!strict.ok) {
      console.warn(`[AutopilotV3][SOURCE AFFILIATE MATCH REJECT] @${result.sourceUsername} productId=${item.productId||'-'} title="${safeTitle(item.title)||'-'}" reference="${strict.reference||clean(result?.visionTarget?.soldObject)||clean(result?.topic)||'-'}" reason=${strict.reason} → SOLD-FIRST 기존 상품 유지`);
      continue;
    }
    console.log(`[AutopilotV3][SOURCE AFFILIATE MATCH PASS] @${result.sourceUsername} productId=${item.productId||'-'} title="${safeTitle(item.title)}" reference="${strict.reference}" overlap="${(strict.overlap||[]).join('/') || '-'}" score=${strict.score}`);
    resolved.push({ ...item, index: i, strictScore: strict.score });
  }
  if (!resolved.length) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] @${result.sourceUsername} 작성자 링크 중 실제 판매대상과 검증 통과한 상품 없음 → SOLD-FIRST 기존 상품 유지`);
    return null;
  }

  resolved.sort((a, b) => (b.strictScore||candidateScore(b,detail,result,b.index)) - (a.strictScore||candidateScore(a,detail,result,a.index)));
  const picked = resolved[0];
  const parsedTitle = safeTitle(picked.title);
  if (!parsedTitle) return null;

  return {
    product: {
      productId: picked.productId || null,
      name: parsedTitle,
      image: null,
      price: null,
      url: picked.url,
      isRocket: false,
      isFreeShipping: false,
      rank: null,
      categoryName: null,
      sourceAffiliateExact: true,
      sourceAffiliateOriginalUrl: picked.sourceUrl,
    },
    sourceUrl: picked.sourceUrl,
    finalUrl: picked.finalUrl,
    method: picked.method,
  };
}

engine.buildThreadsFirstAutopilot = async function sourceAffiliateExactProductBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  try {
    const exact = await findExactSourceProduct(result);
    if (exact?.product?.url) {
      result.product = exact.product;
      result.productSearchTerm = 'source-author-affiliate-link-strict-match';
      result.sourceAffiliateProduct = true;
      result.sourceAffiliateOriginalUrl = exact.sourceUrl;
      console.log(`[AutopilotV3][SOURCE AFFILIATE] 검증 통과 작성자 상품 적용 productId=${exact.product.productId || '-'} product="${clean(exact.product.name)}" method=${exact.method}`);
    } else {
      console.log(`[AutopilotV3][SOURCE AFFILIATE] 작성자 링크 덮어쓰기 없음 → SOLD-FIRST 상품 유지 product="${clean(result?.product?.name)||'-'}"`);
    }
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] 원문 댓글 상품 적용 실패 → SOLD-FIRST 기존 상품 유지 reason="${e.response?.data?.message || e.message}"`);
  }

  return result;
};

console.log('[Autopilot][SOURCE AFFILIATE EXACT PRODUCT] strict title/evidence match ON · title unavailable/mismatch → SOLD-FIRST 유지');
