const benchmark = require('./benchmarkAccounts');

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

function isProfileImage(url) {
  return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(String(url || ''));
}

function isShopPreview(url) {
  const s = String(url || '');
  return /\/emg1\/|thumbnail\.coupangcdn\.com|coupangcdn\.com|shopping\.naver|smartstore\.naver|brand\.naver/i.test(s);
}

function isTrustedThreadsImage(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s) || isProfileImage(s) || isShopPreview(s)) return false;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return h.includes('cdninstagram.com') || h.includes('fbcdn.net');
  } catch { return false; }
}

function isTrustedThreadsVideo(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return h.includes('cdninstagram.com') || h.includes('fbcdn.net') || h.includes('threads.com');
  } catch { return false; }
}

function uniq(list) { return [...new Set((list || []).filter(Boolean))]; }

function saveMaterial(item) {
  if (!item?.url) return;
  const text = String(item.text || item.sourceText || '').trim();
  if (!text) return;
  const images = uniq((Array.isArray(item.images) ? item.images : []).filter(isTrustedThreadsImage)).slice(0, 10);
  const videos = uniq((Array.isArray(item.videos) ? item.videos : []).filter(isTrustedThreadsVideo)).slice(0, 5);
  postCache.set(keyOf(item.url), {
    savedAt: Date.now(),
    username: item.username || '',
    sourceText: text,
    images,
    videos,
    hasVideo: videos.length > 0 || !!item.hasVideo,
  });
}

const originalCollectBenchmarkMaterials = benchmark.collectBenchmarkMaterials.bind(benchmark);
benchmark.collectBenchmarkMaterials = async function patchedCollectBenchmarkMaterials(options) {
  cleanCache();
  const materials = await originalCollectBenchmarkMaterials(options);
  for (const item of materials || []) saveMaterial(item);
  console.log(`[Threads][PROFILE CACHE V3] cached=${(materials || []).length} ttl=${CACHE_TTL / 60000}m trustedMedia=yes`);
  return materials;
};

const originalCollectPostDetails = benchmark.collectPostDetails.bind(benchmark);
benchmark.collectPostDetails = async function patchedCollectPostDetails(url, username) {
  cleanCache();
  const cached = postCache.get(keyOf(url));

  // 처음 프로필 수집에서 원문과 실제 Threads 미디어를 확보했다면 상세페이지를 다시 열지 않는다.
  // 영상 URL이 아직 없고 hasVideo 신호만 있는 경우에는 뒤의 threadsVideoPatch가 해당 post에서 실제 mp4를 추출한다.
  if (cached?.sourceText && (cached.images.length || cached.videos.length || cached.hasVideo)) {
    console.log(`[Threads][PROFILE CACHE HIT V3] @${username || cached.username || '-'} source=${cached.sourceText.length} images=${cached.images.length} videos=${cached.videos.length} hasVideo=${cached.hasVideo ? 'yes' : 'no'} detailRequest=skipped`);
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      affiliateLinks: [],
      images: cached.images,
      videos: cached.videos,
      hasVideo: cached.hasVideo,
      exactUrl: true,
      fromProfileCache: true,
    };
  }

  // 프로필에서 미디어를 못 잡은 후보만 기존 상세 수집을 1회 시도한다.
  try {
    const details = await originalCollectPostDetails(url, username);
    if (details?.sourceText) return details;
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (!cached?.sourceText) {
      console.warn(`[Threads][DETAIL FALLBACK V3] @${username || '-'} detail failed reason="${msg}" cache=no`);
      throw err;
    }
    console.warn(`[Threads][PROFILE CACHE TEXT FALLBACK V3] @${username || cached.username || '-'} detail failed reason="${msg}" source=${cached.sourceText.length}`);
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      affiliateLinks: [],
      images: cached.images || [],
      videos: cached.videos || [],
      hasVideo: !!cached.hasVideo,
      exactUrl: true,
      fromProfileCache: true,
    };
  }

  if (cached?.sourceText) {
    return {
      sourceText: cached.sourceText,
      authorReplies: [],
      affiliateLinks: [],
      images: cached.images || [],
      videos: cached.videos || [],
      hasVideo: !!cached.hasVideo,
      exactUrl: true,
      fromProfileCache: true,
    };
  }

  throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
};

console.log('[Threads][PROFILE CACHE PATCH V3] 프로필 원문+실제 Threads 미디어 재사용 · 쿠팡 프리뷰/프로필 차단 · 상세 재요청 최소화');
