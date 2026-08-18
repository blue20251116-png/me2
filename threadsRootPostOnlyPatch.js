const benchmark = require('./benchmarkAccounts');

const previous = benchmark.collectPostDetails.bind(benchmark);
const mediaCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function normalizePostUrl(url) {
  return String(url || '').replace(/\/media(?:[?#].*)?$/i, '').split(/[?#]/)[0].replace(/\/$/, '');
}
function uniq(list) { return [...new Set((list || []).filter(Boolean))]; }
function isProfileImage(url) {
  return /(?:t51\.82787-19|profile[_-]?pic|profile_pic|avatar|dst-jpg_s150x150|s150x150|150x150|_s150x150_)/i.test(String(url || ''));
}
function isShopPreview(url) {
  return /coupang|coupangcdn|shopping\.naver|smartstore|brand\.naver|\/emg1\//i.test(String(url || ''));
}
function cleanImages(list) {
  return uniq(list).filter(x => /^https?:\/\//i.test(String(x || '')) && !isProfileImage(x) && !isShopPreview(x)).slice(0, 10);
}
function cleanVideos(list) {
  return uniq(list).filter(x => /^https?:\/\//i.test(String(x || ''))).slice(0, 5);
}
function getCached(url) {
  const key = normalizePostUrl(url), v = mediaCache.get(key);
  if (!v || Date.now() - v.savedAt > CACHE_TTL) { mediaCache.delete(key); return null; }
  return v;
}
function setCached(url, data) {
  mediaCache.set(normalizePostUrl(url), { ...data, savedAt: Date.now() });
}

// 핵심: 사진/영상은 상세페이지의 댓글 DOM에서 절대 찾지 않는다.
// 벤치마킹 계정의 프로필 목록에서 "정확히 같은 /post/<shortcode> 카드"를 다시 찾아
// 그 카드에 붙은 원본문 미디어만 사용한다. 댓글/쿠팡 링크 프리뷰는 이 경로에 들어오지 않는다.
async function recoverFromExactProfileCard(url, username) {
  const target = normalizePostUrl(url);
  const cached = getCached(target);
  if (cached) return cached;

  let posts = [];
  try {
    posts = await benchmark.collectProfilePosts(username, { limit: 30 });
  } catch (err) {
    console.warn(`[Threads][ROOT CARD V3] @${username} profile scan failed reason="${String(err?.message || err)}"`);
  }

  const hit = (posts || []).find(p => normalizePostUrl(p?.url) === target);
  const images = cleanImages(hit?.images || []);
  const videos = cleanVideos(hit?.videos || []);
  const hasVideo = videos.length > 0 || !!hit?.hasVideo;
  const data = {
    found: !!hit,
    sourceText: String(hit?.text || '').trim(),
    images,
    videos,
    hasVideo,
    profileCount: (posts || []).length
  };
  setCached(target, data);
  console.log(`[Threads][ROOT CARD V3] @${username} found=${data.found?'yes':'no'} scanned=${data.profileCount} images=${images.length} videos=${videos.length} hasVideo=${hasVideo?'yes':'no'} scope=exact-profile-post-card commentsMedia=ignored`);
  return data;
}

benchmark.collectPostDetails = async function rootPostOnlyV3(url, username) {
  let base = null;
  try {
    base = await previous(url, username);
  } catch (err) {
    console.warn(`[Threads][ROOT CARD V3] base detail failed @${username}: ${String(err?.message || err)}`);
  }

  // PROFILE CACHE V3가 이미 원게시물 미디어를 확보했다면 재요청하지 않는다.
  const baseImages = cleanImages(base?.images || []);
  const baseVideos = cleanVideos(base?.videos || []);
  if (baseImages.length || baseVideos.length) {
    console.log(`[Threads][ROOT CARD V3] @${username} cache-hit images=${baseImages.length} videos=${baseVideos.length} scope=profile-cache-root-card commentsMedia=ignored`);
    return {
      ...(base || {}),
      images: baseImages,
      videos: baseVideos,
      hasVideo: baseVideos.length > 0 || !!base?.hasVideo,
      mediaScope: 'profile-cache-root-card'
    };
  }

  // 상세페이지에서 main=no가 나와도 댓글 DOM을 뒤지지 않는다.
  // 정확한 프로필 post 카드에서만 원본 미디어를 복구한다.
  const root = await recoverFromExactProfileCard(url, username);
  const sourceText = String(base?.sourceText || root.sourceText || '').trim();
  if (!sourceText) throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');

  return {
    ...(base || {}),
    sourceText,
    images: root.images,
    videos: root.videos,
    hasVideo: root.videos.length > 0 || !!root.hasVideo,
    exactUrl: true,
    mediaScope: 'exact-profile-post-card',
    // 댓글은 링크/텍스트 용도만 유지. 댓글의 사진/영상은 절대 합치지 않는다.
    authorReplies: base?.authorReplies || [],
    affiliateLinks: base?.affiliateLinks || []
  };
};

console.log('[Threads][ROOT POST ONLY PATCH V3] 미디어=정확한 프로필 원게시물 카드만 · 댓글 미디어 완전무시 · 댓글은 링크/텍스트 전용');
