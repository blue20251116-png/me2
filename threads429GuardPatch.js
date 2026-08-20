// Threads 웹 직접 접근 429 완화 패치
// - 동일 게시물 상세 결과 20분 캐시
// - 429 감지 시 해당 게시물 URL만 15분 cooldown
// - 다른 게시물/계정 상세 접근은 계속 허용
// - 제한된 게시물은 프로필 목록 fallback 사용
// 발행 API/댓글 스케줄러는 건드리지 않는다.

const benchmark = require('./benchmarkAccounts');

const CACHE_TTL_MS = 20 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const detailCache = new Map();

function canonical(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    u.pathname = u.pathname.replace(/\/media\/?$/i, '').replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw || '').split(/[?#]/)[0].replace(/\/media\/?$/i, '');
  }
}

const guard = global.__THREADS_WEB_GUARD__ || {
  cooldowns: new Map(),
  mark429(source = '') {
    const key = canonical(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    if (!key) return;
    const until = Date.now() + COOLDOWN_MS;
    this.cooldowns.set(key, until);
    console.warn(`[Threads][429 GUARD] 429 감지 → 해당 URL만 15분 cooldown source=${source || '-'} key=${key}`);
  },
  isCooling(source = '') {
    const key = canonical(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    if (!key) return false;
    const until = Number(this.cooldowns.get(key) || 0);
    if (until && until <= Date.now()) this.cooldowns.delete(key);
    return Date.now() < until;
  },
  remainingMinutes(source = '') {
    const key = canonical(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) || String(source || '');
    const until = Number(this.cooldowns.get(key) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 60000));
  },
  clearExpired() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (!until || until <= now) this.cooldowns.delete(key);
  },
};

if (!(guard.cooldowns instanceof Map)) guard.cooldowns = new Map();
global.__THREADS_WEB_GUARD__ = guard;

function clone(value) {
  if (!value) return value;
  return {
    ...value,
    authorReplies: Array.isArray(value.authorReplies) ? [...value.authorReplies] : [],
    images: Array.isArray(value.images) ? [...value.images] : [],
    videos: Array.isArray(value.videos) ? [...value.videos] : [],
  };
}

function is429(err) {
  return Number(err?.response?.status || err?.status || 0) === 429 || /(?:status(?: code)?\s*429|\b429\b|too many requests)/i.test(String(err?.message || ''));
}

async function profileFallback(url, username) {
  if (!username) return null;
  try {
    const posts = await benchmark.collectProfilePosts(username, { limit: 30 });
    const target = canonical(url);
    const hit = (posts || []).find(p => canonical(p?.url) === target);
    if (!hit) return null;
    return {
      sourceText: String(hit.text || '').replace(/\s+/g, ' ').trim(),
      authorReplies: [],
      images: Array.isArray(hit.images) ? hit.images.filter(Boolean) : [],
      videos: [],
      hasVideo: !!hit.hasVideo || Number(hit.videoCount || 0) > 0,
      exactUrl: true,
      webCooldownFallback: true,
    };
  } catch (err) {
    console.warn(`[Threads][429 GUARD] profile fallback 실패 @${username || '-'} reason="${err.message}"`);
    return null;
  }
}

const original = benchmark.collectPostDetails.bind(benchmark);

benchmark.collectPostDetails = async function guardedCollectPostDetails(url, username) {
  const key = canonical(url);
  const cached = detailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[Threads][429 GUARD] detail cache hit @${username || '-'} url=${key}`);
    return clone(cached.value);
  }
  if (cached) detailCache.delete(key);

  if (guard.isCooling(key)) {
    const remain = guard.remainingMinutes(key);
    console.warn(`[Threads][429 GUARD] 이 URL cooldown ${remain}분 남음 → 상세 직접접근 생략 @${username || '-'} url=${key}`);
    const fallback = await profileFallback(key, username);
    if (fallback?.sourceText) {
      detailCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: clone(fallback) });
      return fallback;
    }
    throw new Error(`Threads 웹 요청 제한 cooldown 중입니다 (${remain}분): ${key}`);
  }

  try {
    const result = await original(url, username);
    if (result) detailCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: clone(result) });
    return result;
  } catch (err) {
    if (!is429(err)) throw err;
    guard.mark429(key);
    const fallback = await profileFallback(key, username);
    if (fallback?.sourceText) {
      detailCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: clone(fallback) });
      return fallback;
    }
    throw err;
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [key, item] of detailCache) if (!item || item.expiresAt <= now) detailCache.delete(key);
  guard.clearExpired?.();
}, 10 * 60 * 1000).unref?.();

console.log('[Threads][429 GUARD] 상세 20분 캐시 + 429 발생 시 게시물별 15분 cooldown 활성화');