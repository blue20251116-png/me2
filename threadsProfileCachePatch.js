const benchmark = require('./benchmarkAccounts');

// 프로필 수집 결과의 본문만 캐시한다.
// 미디어는 프로필 카드에서 쿠팡/외부 링크 프리뷰와 구분하기 어려우므로
// 실제 post importer/상세 수집기가 다시 확인하게 한다.
const CACHE_TTL = 10 * 60 * 1000;
const postCache = new Map();

function keyOf(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}`.replace(/\/media$/i, '').replace(/\/$/, '');
  } catch {
    return String(url || '').split(/[?#]/)[0].replace(/\/media$/i, '').replace(/\/$/, '');
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
    // 중요: 프로필 카드의 images/videos는 링크 프리뷰가 섞일 수 있으므로 캐시하지 않는다.
    profileImageCount: Array.isArray(item.images) ? item.images.filter(Boolean).length : 0,
    profileHasVideo: !!item.hasVideo,
  });
}

const originalCollectBenchmarkMaterials = benchmark.collectBenchmarkMaterials.bind(benchmark);
benchmark.collectBenchmarkMaterials = async function patchedCollectBenchmarkMaterials(options) {
  cleanCache();
  const materials = await originalCollectBenchmarkMaterials(options);
  for (const item of materials || []) saveMaterial(item);
  console.log(`[Threads][PROFILE TEXT CACHE] cached=${(materials || []).length} ttl=${CACHE_TTL / 60000}m mediaTrusted=no`);
  return materials;
};

const originalCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);
benchmark.collectPostDetails = async function patchedCollectPostDetails(url, username) {
  cleanCache();
  const cached = postCache.get(keyOf(url));

  // 본문은 캐시를 쓸 수 있지만, 미디어는 실제 post에서 검증해야 한다.
  // 먼저 기존 상세 수집기를 호출한다. 성공하면 원본 미디어/댓글/제휴링크를 그대로 사용한다.
  try {
    const details = await originalCollectPostDetails(url, username);
    if (details?.sourceText) return details;
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (!cached?.sourceText) {
      console.warn(`[Threads][DETAIL FALLBACK] @${username || '-'} detail failed reason="${msg}" cache=no`);
      throw err;
    }
    // 429 등으로 상세 본문만 실패한 경우 텍스트 캐시로 살린다.
    // images/videos는 빈 배열로 반환하여 뒤쪽 browser/video importer가 실제 post 미디어를 복구하게 한다.
    console.warn(`[Threads][PROFILE TEXT CACHE FALLBACK] @${username || cached.username || '-'} detail failed reason="${msg}" source=${cached.sourceText.length} profileImagesIgnored=${cached.profileImageCount || 0} mediaRecovery=required`);
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      affiliateLinks: [],
      images: [],
      videos: [],
      hasVideo: !!cached.profileHasVideo,
      exactUrl: true,
      fromProfileCache: true,
      mediaNeedsRecovery: true,
    };
  }

  if (cached?.sourceText) {
    console.log(`[Threads][PROFILE TEXT CACHE FALLBACK] @${username || cached.username || '-'} source=${cached.sourceText.length} profileImagesIgnored=${cached.profileImageCount || 0} mediaRecovery=required`);
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      affiliateLinks: [],
      images: [],
      videos: [],
      hasVideo: !!cached.profileHasVideo,
      exactUrl: true,
      fromProfileCache: true,
      mediaNeedsRecovery: true,
    };
  }

  throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
};

console.log('[Threads][PROFILE TEXT CACHE PATCH V2] 본문 캐시 유지 · 프로필/쿠팡 링크 프리뷰 미디어 미신뢰 · 실제 post 미디어 복구 강제');
