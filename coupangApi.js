const axios = require('axios');
const crypto = require('crypto');
const { getAccount } = require('./db');

const DOMAIN = 'https://api-gateway.coupang.com';
const PARTNERS_BASE = '/v2/providers/affiliate_open_api/apis/openapi/v1';

function buildAuthHeader(account, method, pathWithQuery) {
  if (!account?.coupang_access_key || !account?.coupang_secret_key) {
    throw new Error('이 계정에 쿠팡파트너스 Access Key/Secret Key가 설정되지 않았습니다');
  }

  const [path, query = ''] = pathWithQuery.split('?');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const signedDate =
    String(now.getUTCFullYear()).slice(2) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    'Z';

  const message = signedDate + method + path + query;
  const signature = crypto
    .createHmac('sha256', account.coupang_secret_key)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${account.coupang_access_key}, signed-date=${signedDate}, signature=${signature}`;
}

function assertPartnersSuccess(data, label) {
  const rCode = data?.rCode;
  if (rCode != null && String(rCode) !== '0') {
    throw new Error(`${label} 실패: rCode=${rCode} ${data?.rMessage || ''}`.trim());
  }
}

function mapProduct(p) {
  return {
    productId: p.productId,
    name: p.productName,
    image: p.productImage,
    price: p.productPrice,
    url: p.productUrl,
    isRocket: !!p.isRocket,
    isFreeShipping: !!p.isFreeShipping,
    rank: p.rank || null,
    categoryName: p.categoryName || null,
  };
}

async function signedGet(accountId, pathWithQuery, label) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);

  const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
    headers: {
      Authorization: buildAuthHeader(account, 'GET', pathWithQuery),
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  assertPartnersSuccess(res.data, label);
  return res.data;
}

async function searchProducts(accountId, keyword, limit = 10) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);

  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) throw new Error('쿠팡 상품 검색어가 비어 있습니다');

  // 쿠팡파트너스 상품검색 API의 limit 최대값은 10이다.
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  const params = new URLSearchParams({
    keyword: cleanKeyword,
    limit: String(safeLimit),
    srpLinkOnly: 'false',
  });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = `${PARTNERS_BASE}/products/search`;
  const pathWithQuery = `${path}?${params.toString()}`;
  const data = await signedGet(accountId, pathWithQuery, '쿠팡 상품검색');

  const list = Array.isArray(data?.data?.productData) ? data.data.productData : [];
  if (!list.length) {
    console.log(`[Coupang][SEARCH] 결과 0개 keyword="${cleanKeyword}" rCode=${data?.rCode ?? '-'} message="${data?.rMessage || ''}"`);
  }
  return list.map(mapProduct);
}

async function createDeeplink(accountId, urls) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);

  const path = `${PARTNERS_BASE}/deeplink`;
  const body = {
    coupangUrls: Array.isArray(urls) ? urls : [urls],
    ...(account.coupang_sub_id ? { subId: account.coupang_sub_id } : {}),
  };

  const res = await axios.post(`${DOMAIN}${path}`, body, {
    headers: {
      Authorization: buildAuthHeader(account, 'POST', path),
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  assertPartnersSuccess(res.data, '쿠팡 딥링크');
  return (res.data?.data || []).map((d) => ({
    originalUrl: d.originalUrl,
    shortenUrl: d.shortenUrl,
    landingUrl: d.landingUrl,
  }));
}

async function getGoldboxProducts(accountId, limit = 20) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);

  // 골드박스 API는 별도 limit 파라미터 없이 호출하는 것이 문서 기준이다.
  const params = new URLSearchParams();
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = `${PARTNERS_BASE}/products/goldbox`;
  const query = params.toString();
  const pathWithQuery = query ? `${path}?${query}` : path;
  const data = await signedGet(accountId, pathWithQuery, '쿠팡 골드박스');
  const list = Array.isArray(data?.data) ? data.data : [];

  if (!list.length) {
    console.log(`[Coupang][GOLDBOX] 결과 0개 account=${accountId} rCode=${data?.rCode ?? '-'} message="${data?.rMessage || ''}"`);
  }

  return list.slice(0, Math.max(1, Number(limit) || 20)).map((p) => ({
    ...mapProduct(p),
    discountRate: p.discountRate || null,
  }));
}

const BEST_CATEGORY_IDS = {
  '여성패션': 1001,
  '남성패션': 1002,
  '뷰티': 1010,
  '출산/유아동': 1011,
  '식품': 1012,
  '주방용품': 1013,
  '생활용품': 1014,
  '홈인테리어': 1015,
  '가전디지털': 1016,
  '스포츠/레저': 1017,
  '자동차용품': 1018,
  '헬스/건강식품': 1024,
  '반려동물용품': 1029,
};

async function getBestCategoryProducts(accountId, categoryId, limit = 20) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const params = new URLSearchParams({ limit: String(safeLimit) });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = `${PARTNERS_BASE}/products/bestcategories/${categoryId}`;
  const pathWithQuery = `${path}?${params.toString()}`;
  const data = await signedGet(accountId, pathWithQuery, '쿠팡 베스트카테고리');
  const list = Array.isArray(data?.data) ? data.data : [];

  if (!list.length) {
    console.log(`[Coupang][BEST] 결과 0개 account=${accountId} category=${categoryId} rCode=${data?.rCode ?? '-'} message="${data?.rMessage || ''}"`);
  }

  return list.map(mapProduct);
}

module.exports = {
  searchProducts,
  createDeeplink,
  getBestCategoryProducts,
  getGoldboxProducts,
  BEST_CATEGORY_IDS,
};
