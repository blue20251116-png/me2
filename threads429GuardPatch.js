// Threads 웹 직접 접근 429 완화 패치
// - 동일 게시물 상세 결과 20분 캐시
// - 429 감지 시 15분 전역 cooldown
// - 영상 추출 패치와 같은 전역 cooldown 상태를 공유
// - cooldown 동안 상세 페이지 재접근 대신 프로필 목록 fallback 사용
// 발행 API/댓글 스케줄러는 건드리지 않는다.

const benchmark = require('./benchmarkAccounts');

const CACHE_TTL_MS = 20 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const detailCache = new Map();

const guard = global.__THREADS_WEB_GUARD__ || {
  cooldownUntil: 0,
  mark429(source = '') {
    this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + COOLDOWN_MS);
    console.warn(`[Threads][429 GUARD] 429 감지 → 15분 cooldown 시작${source ? ` source=${source}` : ''}`);
  },
  isCooling() {
    return Date.now() < Number(this.cooldownUntil || 0);
  },
  remainingMinutes() {
    return Math.max(0, Math.ceil((Number(this.cooldownUntil || 0) - Date.now()) / 60000));
  },
};
global.__THREADS_WEB_GUARD__ = guard;

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
    if (is429(err)) guard.mark429(`profile:${username || '-'}`);
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

  if (guard.isCooling()) {
    const remain = guard.remainingMinutes();
    console.warn(`[Threads][429 GUARD] cooldown ${remain}분 남음 → 상세 직접접근 생략 @${username || '-'} url=${key}`);
    const fallback = await profileFallback(key, username);
    if (fallback?.sourceText) {
      detailCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: clone(fallback) });
      return fallback;
    }
    throw new Error(`Threads 웹 요청 제한 cooldown 중입니다 (${remain}분).`);
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
}, 10 * 60 * 1000).unref?.();

console.log('[Threads][429 GUARD] 상세 20분 캐시 + 429 발생 시 15분 전역 cooldown 활성화');
