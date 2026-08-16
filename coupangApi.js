const axios = require('axios');
const crypto = require('crypto');
const { getAccount, db } = require('./db');

const DOMAIN = 'https://api-gateway.coupang.com';
const PARTNERS_BASE = '/v2/providers/affiliate_open_api/apis/openapi';
const SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;
const EMPTY_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS coupang_api_cache (
  account_id INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(account_id, cache_key)
);
CREATE TABLE IF NOT EXISTS coupang_api_state (
  account_id INTEGER PRIMARY KEY,
  cooldown_until TEXT,
  cooldown_reason TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

function hasCredentials(accountOrId) {
  const account = typeof accountOrId === 'object' ? accountOrId : getAccount(accountOrId);
  return !!(account?.coupang_access_key && account?.coupang_secret_key);
}

function buildAuthHeader(account, method, pathWithQuery) {
  if (!hasCredentials(account)) {
    const err = new Error('쿠팡파트너스 API 키가 설정되지 않았습니다');
    err.code = 'COUPANG_KEYS_MISSING';
    throw err;
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

function makeRateLimitError(message, cooldownUntil) {
  const err = new Error(message);
  err.code = 'COUPANG_RATE_LIMIT';
  err.isCoupangRateLimit = true;
  err.cooldownUntil = cooldownUntil || null;
  return err;
}

function parseRetryTime(message) {
  const m = String(message || '').match(/(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (!m) return null;
  const ms = Date.parse(m[1].replace(/\.(\d{3})\d+$/, '.$1'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function setCooldown(accountId, reason, explicitUntil) {
  const until = explicitUntil || new Date(Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS).toISOString();
  db.prepare(`INSERT INTO coupang_api_state(account_id,cooldown_until,cooldown_reason,updated_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      cooldown_until=excluded.cooldown_until,
      cooldown_reason=excluded.cooldown_reason,
      updated_at=datetime('now')`).run(accountId, until, String(reason || '쿠팡 API 호출 제한'));
  console.error(`[Coupang][COOLDOWN] account=${accountId} until=${until} reason="${String(reason || '').slice(0, 220)}"`);
  return until;
}

function getCooldown(accountId) {
  const row = db.prepare('SELECT cooldown_until,cooldown_reason FROM coupang_api_state WHERE account_id=?').get(accountId);
  if (!row?.cooldown_until) return null;
  if (Date.parse(row.cooldown_until) <= Date.now()) {
    db.prepare('DELETE FROM coupang_api_state WHERE account_id=?').run(accountId);
    return null;
  }
  return row;
}

function assertNotCoolingDown(accountId) {
  const row = getCooldown(accountId);
  if (row) {
    throw makeRateLimitError(
      `쿠팡 API 보호 대기 중입니다. ${row.cooldown_until} 이후 다시 시도합니다. (${row.cooldown_reason || '호출 제한'})`,
      row.cooldown_until
    );
  }
}

function cacheGet(accountId, cacheKey) {
  const row = db.prepare('SELECT payload,expires_at FROM coupang_api_cache WHERE account_id=? AND cache_key=?').get(accountId, cacheKey);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM coupang_api_cache WHERE account_id=? AND cache_key=?').run(accountId, cacheKey);
    return null;
  }
  try { return JSON.parse(row.payload); } catch { return null; }
}

function cacheSet(accountId, cacheKey, payload, ttlMs) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`INSERT INTO coupang_api_cache(account_id,cache_key,payload,expires_at,created_at)
    VALUES(?,?,?,?,datetime('now'))
    ON CONFLICT(account_id,cache_key) DO UPDATE SET
      payload=excluded.payload,
      expires_at=excluded.expires_at,
      created_at=datetime('now')`).run(accountId, cacheKey, JSON.stringify(payload || []), expiresAt);
}

function isRateLimitPayload(data, httpStatus) {
  const rCode = String(data?.rCode ?? '');
  const msg = String(data?.rMessage || data?.message || '');
  return httpStatus === 429 ||
    (httpStatus === 403 && /사용 횟수|rate|limit|초과/i.test(msg)) ||
    (rCode === '403' && /사용 횟수|rate|limit|초과/i.test(msg));
}

function assertPartnersSuccess(accountId, data, label, httpStatus) {
  const rCode = data?.rCode;
  if (isRateLimitPayload(data, httpStatus)) {
    const msg = `${label} 실패: rCode=${rCode ?? httpStatus} ${data?.rMessage || data?.message || 'API 호출 제한'}`.trim();
    const until = setCooldown(accountId, msg, parseRetryTime(msg));
    throw makeRateLimitError(msg, until);
  }
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
  assertNotCoolingDown(accountId);
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);
  if (!hasCredentials(account)) return null;
  try {
    const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
      headers: { Authorization: buildAuthHeader(account, 'GET', pathWithQuery), 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    assertPartnersSuccess(accountId, res.data, label, res.status);
    return res.data;
  } catch (err) {
    if (err.isCoupangRateLimit) throw err;
    const status = err.response?.status;
    const data = err.response?.data;
    if (isRateLimitPayload(data, status)) {
      const msg = `${label} 실패: rCode=${data?.rCode ?? status} ${data?.rMessage || data?.message || err.message}`.trim();
      const until = setCooldown(accountId, msg, parseRetryTime(msg));
      throw makeRateLimitError(msg, until);
    }
    throw err;
  }
}

async function searchProducts(accountId, keyword, limit = 10) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) throw new Error('쿠팡 상품 검색어가 비어 있습니다');

  // API 키가 없는 회원도 서비스의 글쓰기/영상/Threads 기능을 그대로 쓸 수 있게 한다.
  // 상품 검색만 빈 결과로 부드럽게 폴백한다.
  if (!hasCredentials(account)) {
    console.log(`[Coupang][OPTIONAL] account=${accountId} API 키 없음 — 상품검색 생략`);
    return [];
  }

  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  const normalizedKey = cleanKeyword.toLowerCase().replace(/\s+/g, ' ').trim();
  const cacheKey = `search:${normalizedKey}:${safeLimit}`;
  const cached = cacheGet(accountId, cacheKey);
  if (cached) return cached;

  assertNotCoolingDown(accountId);
  const params = new URLSearchParams({ keyword: cleanKeyword, limit: String(safeLimit), srpLinkOnly: 'false' });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);
  const path = `${PARTNERS_BASE}/products/search`;
  const data = await signedGet(accountId, `${path}?${params.toString()}`, '쿠팡 상품검색');
  const list = Array.isArray(data?.data?.productData) ? data.data.productData.map(mapProduct) : [];
  cacheSet(accountId, cacheKey, list, list.length ? SEARCH_CACHE_MS : EMPTY_CACHE_MS);
  return list;
}

async function createDeeplink(accountId, urls) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);
  const input = Array.isArray(urls) ? urls : [urls];

  // API 키가 없으면 사용자가 넣은 원본 링크를 그대로 사용한다.
  if (!hasCredentials(account)) {
    return input.map((url) => ({ originalUrl: url, shortenUrl: url, landingUrl: url, passthrough: true }));
  }

  assertNotCoolingDown(accountId);
  const path = `${PARTNERS_BASE}/deeplink`;
  const body = { coupangUrls: input, ...(account.coupang_sub_id ? { subId: account.coupang_sub_id } : {}) };
  try {
    const res = await axios.post(`${DOMAIN}${path}`, body, {
      headers: { Authorization: buildAuthHeader(account, 'POST', path), 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    assertPartnersSuccess(accountId, res.data, '쿠팡 딥링크', res.status);
    return (res.data?.data || []).map((d) => ({ originalUrl: d.originalUrl, shortenUrl: d.shortenUrl, landingUrl: d.landingUrl }));
  } catch (err) {
    if (err.isCoupangRateLimit) throw err;
    const data = err.response?.data;
    const status = err.response?.status;
    if (isRateLimitPayload(data, status)) {
      const msg = `쿠팡 딥링크 실패: ${data?.rMessage || data?.message || err.message}`;
      const until = setCooldown(accountId, msg, parseRetryTime(msg));
      throw makeRateLimitError(msg, until);
    }
    throw err;
  }
}

async function getGoldboxProducts(accountId, limit = 20) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);
  if (!hasCredentials(account)) return [];

  const cacheKey = 'goldbox';
  const cached = cacheGet(accountId, cacheKey);
  if (cached) return cached.slice(0, limit);
  assertNotCoolingDown(accountId);
  const params = new URLSearchParams();
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);
  const path = `${PARTNERS_BASE}/products/goldbox`;
  const q = params.toString();
  const data = await signedGet(accountId, q ? `${path}?${q}` : path, '쿠팡 골드박스');
  const list = Array.isArray(data?.data) ? data.data.map((p) => ({ ...mapProduct(p), discountRate: p.discountRate || null })) : [];
  cacheSet(accountId, cacheKey, list, list.length ? SEARCH_CACHE_MS : EMPTY_CACHE_MS);
  return list.slice(0, Math.max(1, Number(limit) || 20));
}

const BEST_CATEGORY_IDS = {
  '여성패션': 1001, '남성패션': 1002, '뷰티': 1010, '출산/유아동': 1011, '식품': 1012,
  '주방용품': 1013, '생활용품': 1014, '홈인테리어': 1015, '가전디지털': 1016,
  '스포츠/레저': 1017, '자동차용품': 1018, '헬스/건강식품': 1024, '반려동물용품': 1029,
};

async function getBestCategoryProducts(accountId, categoryId, limit = 20) {
  const account = getAccount(accountId);
  if (!account) throw new Error(`쿠팡 계정을 찾을 수 없습니다: accountId=${accountId}`);
  if (!hasCredentials(account)) return [];

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const cacheKey = `best:${categoryId}:${safeLimit}`;
  const cached = cacheGet(accountId, cacheKey);
  if (cached) return cached;
  assertNotCoolingDown(accountId);
  const params = new URLSearchParams({ limit: String(safeLimit) });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);
  const path = `${PARTNERS_BASE}/products/bestcategories/${categoryId}`;
  const data = await signedGet(accountId, `${path}?${params.toString()}`, '쿠팡 베스트카테고리');
  const list = Array.isArray(data?.data) ? data.data.map(mapProduct) : [];
  cacheSet(accountId, cacheKey, list, list.length ? SEARCH_CACHE_MS : EMPTY_CACHE_MS);
  return list;
}

function isRateLimitError(err) {
  return !!(err?.isCoupangRateLimit || err?.code === 'COUPANG_RATE_LIMIT');
}
function getApiCooldown(accountId) { return getCooldown(accountId); }

module.exports = {
  searchProducts,
  createDeeplink,
  getBestCategoryProducts,
  getGoldboxProducts,
  BEST_CATEGORY_IDS,
  isRateLimitError,
  getApiCooldown,
  hasCredentials,
};
