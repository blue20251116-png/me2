const benchmark = require('./benchmarkAccounts');

// Threads 프로필 수집 단계에서 이미 확보한 본문/사진을 URL별로 잠시 보관한다.
// 상세 post를 다시 여는 요청을 줄여 Railway IP의 429를 피하는 것이 목적이다.
const CACHE_TTL = 10 * 60 * 1000;
const postCache = new Map();

function keyOf(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return String(url || '').split(/[?#]/)[0].replace(/\/$/, '');
  }
}

function cleanCache() {
  const now = Date.now();
  for (const [key, value] of postCache) {
    if (!value || now - value.savedAt > CACHE_TTL) postCache.delete(key);
  }
}

function saveMaterial(item) {
  if (!item?.url) return;
  const text = String(item.text || item.sourceText || '').trim();
  if (!text) return;
  postCache.set(keyOf(item.url), {
    savedAt: Date.now(),
    username: item.username || '',
    sourceText: text,
    images: Array.isArray(item.images) ? item.images.filter(Boolean) : [],
    videos: Array.isArray(item.videos) ? item.videos.filter(Boolean) : [],
    hasVideo: !!item.hasVideo,
  });
}

const originalCollectBenchmarkMaterials = benchmark.collectBenchmarkMaterials.bind(benchmark);
benchmark.collectBenchmarkMaterials = async function patchedCollectBenchmarkMaterials(options) {
  cleanCache();
  const materials = await originalCollectBenchmarkMaterials(options);
  for (const item of materials || []) saveMaterial(item);
  console.log(`[Threads][PROFILE CACHE] cached=${(materials || []).length} ttl=${CACHE_TTL / 60000}m`);
  return materials;
};

const originalCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);
benchmark.collectPostDetails = async function patchedCollectPostDetails(url, username) {
  cleanCache();
  const cached = postCache.get(keyOf(url));

  // 프로필 화면에서 원문이 이미 확보된 경우 상세 HTML을 다시 요청하지 않는다.
  // 댓글/제휴링크가 없어도 이후 Autopilot 상품검색 fallback이 처리한다.
  if (cached?.sourceText) {
    console.log(`[Threads][PROFILE CACHE HIT] @${username || cached.username || '-'} source=${cached.sourceText.length} images=${cached.images.length} hasVideo=${cached.hasVideo ? 'yes' : 'no'} detailRequest=skipped`);
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      images: cached.images,
      videos: cached.videos,
      hasVideo: cached.hasVideo,
      exactUrl: true,
      fromProfileCache: true,
    };
  }

  // 캐시에 없는 직접 URL만 기존 상세 수집기를 사용한다.
  try {
    return await originalCollectPostDetails(url, username);
  } catch (err) {
    const msg = String(err?.message || err || '');
    console.warn(`[Threads][DETAIL FALLBACK] @${username || '-'} detail failed reason="${msg}"`);
    throw err;
  }
};

console.log('[Threads][PROFILE CACHE PATCH] 프로필에서 확보한 원문/사진 재사용 · 상세 재요청 최소화 · 429 완화');
