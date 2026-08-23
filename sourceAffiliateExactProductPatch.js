const axios = require('axios');
const { collectPostDetails } = require('./benchmarkAccounts');
const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}
function isBlockedTitle(v) {
  const t = clean(v).toLowerCase();
  return !t || /access denied|forbidden|robot check|captcha|쿠팡 로그인|로그인이 필요|페이지를 찾을 수 없|요청하신 페이지|error 403|403 forbidden/i.test(t);
}
function safeTitle(v) {
  const t = clean(v);
  return isBlockedTitle(t) ? '' : t;
}

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

function findProductNameInJson(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductNameInJson(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
  if (/\bProduct\b/i.test(type) && safeTitle(value.name)) return safeTitle(value.name);
  for (const child of Object.values(value)) {
    const found = findProductNameInJson(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function titleFromJsonLd(html) {
  const scripts = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    const raw = decodeHtml(m?.[1] || '');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const found = findProductNameInJson(parsed);
      if (found) return found;
    } catch {}
  }
  return '';
}

function titleFromHtml(html) {
  const s = String(html || '');
  const og = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
    || s.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i)
    || s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i);
  if (og?.[1]) return safeTitle(decodeHtml(og[1]).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim());
  const jsonLd = titleFromJsonLd(s);
  if (jsonLd) return safeTitle(jsonLd.replace(/\s*-\s*쿠팡!?\s*$/i, '').trim());
  const t = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t?.[1] ? safeTitle(decodeHtml(t[1]).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim()) : '';
}

function numericParamFrom(value, key) {
  const s = String(value || '');
  try {
    const u = new URL(s);
    const v = u.searchParams.get(key);
    if (/^\d+$/.test(String(v || ''))) return String(v);
  } catch {}
  const re = new RegExp(`[?&]${key}=(\\d+)`, 'i');
  return s.match(re)?.[1] || null;
}
function productIdFrom(value) {
  const s = String(value || '');
  return s.match(/\/vp\/products\/(\d+)/i)?.[1]
    || numericParamFrom(s, 'productId')
    || null;
}
function itemIdFrom(value) { return numericParamFrom(value, 'itemId'); }
function vendorItemIdFrom(value) { return numericParamFrom(value, 'vendorItemId'); }

function canonicalProductUrl(finalUrl, html) {
  const productId = productIdFrom(finalUrl) || productIdFrom(html);
  const itemId = itemIdFrom(finalUrl) || itemIdFrom(html);
  const vendorItemId = vendorItemIdFrom(finalUrl) || vendorItemIdFrom(html);
  if (productId) {
    const params = new URLSearchParams();
    if (itemId) params.set('itemId', itemId);
    if (vendorItemId) params.set('vendorItemId', vendorItemId);
    const q = params.toString();
    return {
      productId,
      itemId: itemId || null,
      vendorItemId: vendorItemId || null,
      url: `https://www.coupang.com/vp/products/${productId}${q ? `?${q}` : ''}`,
    };
  }
  if (/^https?:\/\/(?:www\.)?coupang\.com\//i.test(String(finalUrl || ''))) {
    return {
      productId: null,
      itemId: itemId || null,
      vendorItemId: vendorItemId || null,
      url: String(finalUrl).split('#')[0],
    };
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
    maxContentLength: 3 * 1024 * 1024,
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

async function browserVisibleTitle(page) {
  const candidates = [];
  const add = v => { v = safeTitle(clean(v).replace(/\s*-\s*쿠팡!?\s*$/i, '').trim()); if (v && !candidates.includes(v)) candidates.push(v); };
  add(await page.locator('meta[property="og:title"]').getAttribute('content').catch(() => ''));
  add(await page.locator('meta[name="twitter:title"]').getAttribute('content').catch(() => ''));
  add(await page.locator('[data-testid="product-title"]').first().innerText().catch(() => ''));
  add(await page.locator('.prod-buy-header__title').first().innerText().catch(() => ''));
  add(await page.locator('[class*="product-title"]').first().innerText().catch(() => ''));
  add(await page.locator('h1').first().innerText().catch(() => ''));
  const html = await page.content().catch(() => '');
  add(titleFromHtml(html));
  add(await page.title().catch(() => ''));
  return candidates[0] || '';
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
    await page.waitForTimeout(1000);
    let finalUrl = page.url();
    let html = await page.content().catch(() => '');
    let canonical = canonicalProductUrl(finalUrl, html);
    if (!canonical) return null;
    let title = await browserVisibleTitle(page);

    if (!title && canonical.productId) {
      const canonicalUrl = canonical.url || `https://www.coupang.com/vp/products/${canonical.productId}`;
      try {
        await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1200);
        finalUrl = page.url();
        html = await page.content().catch(() => '');
        canonical = canonicalProductUrl(finalUrl, html) || canonical;
        title = await browserVisibleTitle(page);
        if (title) console.log(`[AutopilotV3][SOURCE AFFILIATE] canonical browser title 복구 성공 productId=${canonical.productId || '-'} itemId=${canonical.itemId || '-'} vendorItemId=${canonical.vendorItemId || '-'} title="${clean(title)}"`);
      } catch (e) {
        console.warn(`[AutopilotV3][SOURCE AFFILIATE] canonical browser 재접근 실패 productId=${canonical.productId || '-'} reason="${e.message}"`);
      }
    }

    return {
      sourceUrl,
      finalUrl,
      ...canonical,
      title: safeTitle(title),
      method: 'browser',
    };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

async function resolveSourceLink(sourceUrl) {
  let axiosResult = null;
  try {
    axiosResult = await resolveWithAxios(sourceUrl);
    if (axiosResult?.url && safeTitle(axiosResult.title)) return axiosResult;
    if (axiosResult?.url) {
      console.log(`[AutopilotV3][SOURCE AFFILIATE] axios URL 해석 성공·title 없음 → browser title fallback productId=${axiosResult.productId || '-'}`);
    }
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] axios 해석 실패 url=${sourceUrl} reason="${e.message}"`);
  }

  try {
    const browserResult = await resolveWithBrowser(sourceUrl);
    if (browserResult?.url && safeTitle(browserResult.title)) return browserResult;
    if (browserResult?.url) {
      console.warn(`[AutopilotV3][SOURCE AFFILIATE] browser/JSON-LD/DOM/canonical까지 title 없음 productId=${browserResult.productId || '-'}`);
    }
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] browser 해석 실패 url=${sourceUrl} reason="${e.message}"`);
  }

  return axiosResult?.url ? axiosResult : null;
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
function unique(arr) { return [...new Set((arr || []).filter(Boolean))]; }

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
  return { ok, score:Math.round(ratio * 100) + overlap.length * 10, overlap, reason:ok ? 'token-match' : 'token-mismatch' };
}

function strictSourceProductMatch(candidate, result) {
  const title = safeTitle(candidate?.title);
  if (!title) return { ok:false, score:0, reason:'title-unavailable', reference:'' };
  const references = unique([
    clean(result?.visionTarget?.soldObject),
    ...(Array.isArray(result?.visionTarget?.searchTerms) ? result.visionTarget.searchTerms.map(clean) : []),
    clean(result?.topic),
    clean(result?.product?.name),
  ]).filter(Boolean);
  if (!references.length) return { ok:false, score:0, reason:'no-evidence', reference:'' };
  let best = { ok:false, score:0, reason:'no-match', reference:'', overlap:[] };
  for (const reference of references) {
    const m = matchReferenceToTitle(reference, title);
    if (m.score > best.score) best = { ...m, reference };
    if (m.ok && m.score >= best.score) best = { ...m, reference };
  }
  return best;
}

function usableResolvedProduct(item) {
  return !!(item?.url && /^\d+$/.test(String(item?.productId || '')) && safeTitle(item?.title));
}
function dedupeResolvedProducts(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!usableResolvedProduct(item)) continue;
    const key = String(item.productId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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

  const allResolved = [];
  for (let i = 0; i < links.length; i++) {
    const item = await resolveSourceLink(links[i]);
    if (!item?.url) continue;
    allResolved.push({ ...item, index:i });
  }

  const resolved = dedupeResolvedProducts(allResolved);
  if (!resolved.length) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] @${result.sourceUsername} productId+정상 title까지 확인된 작성자 상품 없음 → SOLD-FIRST 기존 상품 유지`);
    return null;
  }

  let picked = null;
  if (links.length === 1 && resolved.length === 1) {
    picked = resolved[0];
    console.log(`[AutopilotV3][SOURCE AFFILIATE GROUND TRUTH] @${result.sourceUsername} single-link productId=${picked.productId} itemId=${picked.itemId || '-'} vendorItemId=${picked.vendorItemId || '-'} title="${safeTitle(picked.title)}" → 작성자 원본 상품 우선`);
  } else {
    const matched = [];
    for (const item of resolved) {
      const strict = strictSourceProductMatch(item, result);
      if (!strict.ok) {
        console.warn(`[AutopilotV3][SOURCE AFFILIATE MATCH REJECT] @${result.sourceUsername} productId=${item.productId || '-'} title="${safeTitle(item.title) || '-'}" reference="${strict.reference || clean(result?.visionTarget?.soldObject) || clean(result?.topic) || '-'}" reason=${strict.reason}`);
        continue;
      }
      console.log(`[AutopilotV3][SOURCE AFFILIATE MATCH PASS] @${result.sourceUsername} productId=${item.productId || '-'} title="${safeTitle(item.title)}" reference="${strict.reference}" overlap="${(strict.overlap || []).join('/') || '-'}" score=${strict.score}`);
      matched.push({ ...item, strictScore:strict.score });
    }

    if (!matched.length) {
      console.warn(`[AutopilotV3][SOURCE AFFILIATE] @${result.sourceUsername} 다중 작성자 링크 중 판매대상과 일치하는 상품 없음 → SOLD-FIRST 기존 상품 유지`);
      return null;
    }
    matched.sort((a, b) => (b.strictScore || 0) - (a.strictScore || 0));
    if (matched.length > 1) {
      const top = Number(matched[0].strictScore || 0);
      const second = Number(matched[1].strictScore || 0);
      if (top - second < 20) {
        console.warn(`[AutopilotV3][SOURCE AFFILIATE AMBIGUOUS] @${result.sourceUsername} 다중링크 score=${top}/${second} margin=${top-second} < 20 → 덮어쓰기 금지 · SOLD-FIRST 유지`);
        return null;
      }
    }
    picked = matched[0];
    console.log(`[AutopilotV3][SOURCE AFFILIATE WINNER] @${result.sourceUsername} productId=${picked.productId} score=${picked.strictScore} title="${safeTitle(picked.title)}"`);
  }

  const parsedTitle = safeTitle(picked?.title);
  if (!picked || !parsedTitle || !picked.productId) return null;

  return {
    product: {
      productId: picked.productId || null,
      itemId: picked.itemId || null,
      vendorItemId: picked.vendorItemId || null,
      name: parsedTitle,
      image: null,
      price: null,
      url: picked.url,
      isRocket: false,
      isFreeShipping: false,
      rank: null,
      categoryName: null,
      sourceAffiliateExact: true,
      sourceAffiliateGroundTruth: links.length === 1,
      sourceAffiliateOriginalUrl: picked.sourceUrl,
    },
    sourceUrl: picked.sourceUrl,
    finalUrl: picked.finalUrl,
    method: picked.method,
    groundTruth: links.length === 1,
  };
}

engine.buildThreadsFirstAutopilot = async function sourceAffiliateExactProductBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  try {
    const exact = await findExactSourceProduct(result);
    if (exact?.product?.url) {
      result.product = exact.product;
      result.productSearchTerm = exact.groundTruth ? 'source-author-affiliate-link-ground-truth' : 'source-author-affiliate-link-unique-winner';
      result.sourceAffiliateProduct = true;
      result.sourceAffiliateGroundTruth = !!exact.groundTruth;
      result.sourceAffiliateOriginalUrl = exact.sourceUrl;
      console.log(`[AutopilotV3][SOURCE AFFILIATE] 작성자 상품 적용 productId=${exact.product.productId || '-'} itemId=${exact.product.itemId || '-'} vendorItemId=${exact.product.vendorItemId || '-'} product="${clean(exact.product.name)}" method=${exact.method} groundTruth=${exact.groundTruth?'yes':'no'}`);
    } else {
      console.log(`[AutopilotV3][SOURCE AFFILIATE] 작성자 링크 덮어쓰기 없음 → SOLD-FIRST 상품 유지 product="${clean(result?.product?.name) || '-'}"`);
    }
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE AFFILIATE] 원문 댓글 상품 적용 실패 → SOLD-FIRST 기존 상품 유지 reason="${e.response?.data?.message || e.message}"`);
  }
  return result;
};

console.log('[Autopilot][SOURCE AFFILIATE EXACT PRODUCT] v3 single-link productId+title ground truth · item/vendor identity · multi-link unique-winner · axios+browser fail-safe');
