'use strict';

const axios = require('axios');
const { collectPostDetails } = require('./benchmarkAccounts');
const engine = require('./autopilotMaterialEngine');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
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

function numericParamFrom(value, key) {
  const s = String(value || '');
  try {
    const u = new URL(s);
    const v = u.searchParams.get(key);
    if (/^\d+$/.test(String(v || ''))) return String(v);
  } catch {}
  return s.match(new RegExp(`[?&]${key}=(\\d+)`, 'i'))?.[1] || null;
}

function productIdFrom(value) {
  const s = String(value || '');
  return s.match(/\/vp\/products\/(\d+)/i)?.[1]
    || numericParamFrom(s, 'productId')
    || null;
}
function itemIdFrom(value) { return numericParamFrom(value, 'itemId'); }
function vendorItemIdFrom(value) { return numericParamFrom(value, 'vendorItemId'); }

function canonicalFrom(...values) {
  const sources = values.map(v => String(v || '')).filter(Boolean);
  const productId = sources.map(productIdFrom).find(Boolean);
  if (!productId) return null;
  const itemId = sources.map(itemIdFrom).find(Boolean);
  const vendorItemId = sources.map(vendorItemIdFrom).find(Boolean);
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

function responseLocation(res) {
  return clean(res?.headers?.location || res?.headers?.Location || '');
}

function responseFinalUrl(res, fallback) {
  return clean(
    res?.request?.res?.responseUrl
    || res?.request?._redirectable?._currentUrl
    || fallback
  );
}

async function resolveOriginalProductId(sourceUrl) {
  try {
    const direct = canonicalFrom(sourceUrl);
    if (direct) return { ...direct, sourceUrl, finalUrl:sourceUrl, method:'direct' };

    // First inspect the affiliate redirect itself. Some Coupang short links expose
    // the canonical product URL in Location even when the eventual product page
    // blocks or rewrites a server-side request.
    let firstLocation = '';
    try {
      const first = await axios.get(sourceUrl, {
        maxRedirects: 0,
        timeout: 7000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.7',
        },
        validateStatus: s => s >= 200 && s < 500,
        maxContentLength: 256 * 1024,
      });
      firstLocation = responseLocation(first);
      const fromHeader = canonicalFrom(firstLocation, sourceUrl);
      if (fromHeader) return { ...fromHeader, sourceUrl, finalUrl:firstLocation || sourceUrl, method:'redirect-location' };
    } catch (e) {
      firstLocation = clean(e?.response?.headers?.location || e?.response?.headers?.Location || '');
      const fromErrorHeader = canonicalFrom(firstLocation, sourceUrl);
      if (fromErrorHeader) return { ...fromErrorHeader, sourceUrl, finalUrl:firstLocation || sourceUrl, method:'redirect-error-location' };
    }

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
    const finalUrl = responseFinalUrl(res, sourceUrl);
    const location = responseLocation(res) || firstLocation;
    const html = typeof res.data === 'string' ? res.data : '';
    const canonical = canonicalFrom(finalUrl, location, html, sourceUrl);
    return canonical ? { ...canonical, sourceUrl, finalUrl, method:'axios-productId' } : null;
  } catch (e) {
    console.warn(`[AutopilotV3][SOURCE LINK PRIORITY] 원본 링크 productId 해석 실패 url=${sourceUrl} reason="${e.message}"`);
    return null;
  }
}

function failClosed(message, code) {
  const err = new Error(message);
  err.code = code;
  err.__sourceAffiliateFailClosed = true;
  return err;
}

engine.buildThreadsFirstAutopilot = async function sourceAffiliateOriginalLinkPriorityBuild(accountId, options) {
  const result = await originalBuild(accountId, options);
  if (!result) return result;

  if (result.sourceAffiliateProduct && result?.product?.productId) {
    console.log(`[AutopilotV3][SOURCE LINK PRIORITY] 기존 SOURCE EXACT 유지 productId=${result.product.productId}`);
    return result;
  }

  if (!result?.sourceUrl || !result?.sourceUsername) return result;

  const detail = await collectPostDetails(result.sourceUrl, result.sourceUsername);
  const links = extractCoupangLinks(detail?.authorReplies);
  if (!links.length) return result;

  const resolved = [];
  for (const link of links) {
    const item = await resolveOriginalProductId(link);
    if (item?.productId) resolved.push(item);
  }

  const byProductId = new Map();
  for (const item of resolved) {
    if (!byProductId.has(String(item.productId))) byProductId.set(String(item.productId), item);
  }
  const unique = [...byProductId.values()];

  if (!unique.length) {
    console.warn(`[AutopilotV3][SOURCE LINK PRIORITY][REJECT] @${result.sourceUsername} 작성자 쿠팡 링크=${links.length} productId 확정=0 → SOLD-FIRST 금지 · 다음 소재`);
    throw failClosed(`작성자 쿠팡 원본 링크의 실제 productId를 확인하지 못했습니다: @${result.sourceUsername}`, 'SOURCE_AFFILIATE_PRODUCT_ID_UNRESOLVED');
  }

  if (unique.length > 1) {
    console.warn(`[AutopilotV3][SOURCE LINK PRIORITY][AMBIGUOUS] @${result.sourceUsername} productIds=${unique.map(x=>x.productId).join(',')} → SOLD-FIRST 금지 · 다음 소재`);
    throw failClosed(`작성자 쿠팡 원본 링크가 서로 다른 여러 상품을 가리킵니다: @${result.sourceUsername}`, 'SOURCE_AFFILIATE_MULTIPLE_PRODUCTS');
  }

  const picked = unique[0];
  const fallbackName = clean(
    result?.visionTarget?.soldObject
    || result?.topic
    || result?.product?.name
    || '원본 작성자 상품'
  );

  result.product = {
    ...(result.product || {}),
    productId: picked.productId,
    itemId: picked.itemId || null,
    vendorItemId: picked.vendorItemId || null,
    name: fallbackName,
    url: picked.url,
    sourceAffiliateExact: true,
    sourceAffiliateGroundTruth: true,
    sourceAffiliateOriginalUrl: picked.sourceUrl,
    sourceAffiliateProductIdGroundTruth: true,
  };
  result.productSearchTerm = 'source-author-affiliate-productId-ground-truth';
  result.sourceAffiliateProduct = true;
  result.sourceAffiliateGroundTruth = true;
  result.sourceAffiliateOriginalUrl = picked.sourceUrl;

  console.log(`[AutopilotV3][SOURCE LINK PRIORITY][GROUND TRUTH] @${result.sourceUsername} productId=${picked.productId} itemId=${picked.itemId || '-'} vendorItemId=${picked.vendorItemId || '-'} method=${picked.method || '-'} → 작성자 원본 상품 최우선 · SOLD-FIRST 덮어쓰기 차단`);
  return result;
};

console.log('[Autopilot][SOURCE LINK PRIORITY] v2 author Coupang productId ground-truth first · redirect Location resolver · unresolved/ambiguous fail-closed · SOLD-FIRST fallback blocked when source link exists');
