const axios = require('axios');
const crypto = require('crypto');
const { getAccount } = require('./db');

const DOMAIN = 'https://api-gateway.coupang.com';

// 쿠팡파트너스 Open API는 HMAC-SHA256 서명 인증(CEA 알고리즘)을 사용한다.
function buildAuthHeader(account, method, pathWithQuery) {
  if (!account.coupang_access_key || !account.coupang_secret_key) {
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
  const signature = crypto.createHmac('sha256', account.coupang_secret_key).update(message).digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${account.coupang_access_key}, signed-date=${signedDate}, signature=${signature}`;
}

async function searchProducts(accountId, keyword, limit = 10) {
  const account = getAccount(accountId);
  const params = new URLSearchParams({ keyword, limit: String(limit) });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const pathWithQuery = `${path}?${params.toString()}`;

  const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
    headers: { Authorization: buildAuthHeader(account, 'GET', pathWithQuery) },
    timeout: 10000,
  });

  const list = res.data?.data?.productData || [];
  return list.map((p) => ({
    productId: p.productId,
    name: p.productName,
    image: p.productImage,
    price: p.productPrice,
    url: p.productUrl,
    isRocket: !!p.isRocket,
    isFreeShipping: !!p.isFreeShipping,
  }));
}

async function createDeeplink(accountId, urls) {
  const account = getAccount(accountId);
  const path = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
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

  return (res.data?.data || []).map((d) => ({
    originalUrl: d.originalUrl,
    shortenUrl: d.shortenUrl,
    landingUrl: d.landingUrl,
  }));
}

// 카테고리별 베스트 상품 조회 — 키워드 검색과 별개인 쿠팡파트너스 랭킹 기반 엔드포인트.
// 검색 API는 "그 키워드에 걸리는 상품"을 주는 거라 실제 잘 팔리는지는 보장 안 되는데,
// 이건 쿠팡이 매기는 카테고리별 베스트셀러 순위를 그대로 준다.
// categoryId는 쿠팡파트너스가 정의한 고정 카테고리 코드(displayCategoryCode와는 다른 체계)라
// 아래 목록은 커뮤니티에 통용되는 값 기준 — 실제 응답이 비거나 에러 나는 카테고리가 있으면
// 파트너스 사이트(https://partners.coupang.com) "베스트 카테고리" 화면에서 정확한 코드로 교체할 것
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
  const params = new URLSearchParams({ limit: String(limit) });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = `/v2/providers/affiliate_open_api/apis/openapi/products/bestcategories/${categoryId}`;
  const pathWithQuery = `${path}?${params.toString()}`;

  const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
    headers: { Authorization: buildAuthHeader(account, 'GET', pathWithQuery) },
    timeout: 10000,
  });

  const list = res.data?.data || [];
  return list.map((p) => ({
    productId: p.productId,
    name: p.productName,
    image: p.productImage,
    price: p.productPrice,
    url: p.productUrl,
    isRocket: !!p.isRocket,
    isFreeShipping: !!p.isFreeShipping,
    rank: p.rank || null,
  }));
}

module.exports = { searchProducts, createDeeplink, getBestCategoryProducts, BEST_CATEGORY_IDS };
