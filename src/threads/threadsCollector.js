'use strict';
// The app-facing API for reading Threads posts. All browser work happens in the isolated worker
// (threadsScraper.js via infra/browserTasks); this module adds caching and 429 back-off on top.
const { runBrowserTask } = require('../infra/isolatedTask');
const { canonicalPostUrl, isHttpVideoUrl, isTextReadFailure } = require('./postUrls');

const scraper = (method, ...args) => runBrowserTask('threadsScraper', method, args);
const collectBenchmarkMaterials = options => scraper('collectBenchmarkMaterials', options);
const collectProfilePosts = (username, options) => scraper('collectProfilePosts', username, options);

// One uncached read. If the worker still reports a text-read failure, try the profile fallback;
// if the post has video without a playable URL, run one more extraction pass.
async function collectPostDetailsOnce(url, username) {
  let details;
  try {
    details = await scraper('collectPostDetails', url, username);
  } catch (err) {
    if (!isTextReadFailure(err)) throw err;
    console.warn(
      `[Threads][EARLY TEXT FALLBACK] 원문 직접 추출 실패 → 프로필 fallback @${username || '-'} source=${url}`
    );
    details = await scraper('videoFallbackFromProfile', url, username);
    if (!details || !String(details.sourceText || '').trim()) throw err;
  }
  const existing = Array.isArray(details?.videos) ? details.videos.filter(isHttpVideoUrl) : [];
  if (existing.length) return { ...details, videos: existing, hasVideo: true };
  if (!details?.hasVideo) return details;
  const videos = await scraper('extractPlayableVideoUrls', url);
  console.log(`[Threads][VIDEO EXTRACT] @${username || '-'} detected=yes playable=${videos.length}`);
  return { ...details, videos, hasVideo: true };
}

const THREADS_429_CACHE_TTL_MS = 20 * 60 * 1000;
const THREADS_429_COOLDOWN_MS = 15 * 60 * 1000;
const threads429DetailCache = new Map();
const threads429Guard = {
  cooldowns: new Map(),
  mark429(source = '') {
    const key =
      canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) ||
      String(source || '');
    if (!key) return;
    const until = Date.now() + THREADS_429_COOLDOWN_MS;
    this.cooldowns.set(key, until);
    console.warn(`[Threads][429 GUARD] 429 감지 → 해당 URL만 15분 cooldown source=${source || '-'} key=${key}`);
  },
  isCooling(source = '') {
    const key =
      canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) ||
      String(source || '');
    if (!key) return false;
    const until = Number(this.cooldowns.get(key) || 0);
    if (until && until <= Date.now()) this.cooldowns.delete(key);
    return Date.now() < until;
  },
  remainingMinutes(source = '') {
    const key =
      canonicalPostUrl(source.replace(/^video(?:-page|-response)?:/, '').replace(/^profile:/, '')) ||
      String(source || '');
    const until = Number(this.cooldowns.get(key) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 60000));
  },
  clearExpired() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (!until || until <= now) this.cooldowns.delete(key);
  },
};
function threads429CloneDetail(value) {
  if (!value) return value;
  return {
    ...value,
    authorReplies: Array.isArray(value.authorReplies) ? [...value.authorReplies] : [],
    images: Array.isArray(value.images) ? [...value.images] : [],
    videos: Array.isArray(value.videos) ? [...value.videos] : [],
  };
}
function is429Error(err) {
  return (
    Number(err?.response?.status || err?.status || 0) === 429 ||
    /(?:status(?: code)?\s*429|\b429\b|too many requests)/i.test(String(err?.message || ''))
  );
}
async function threads429ProfileFallback(url, username) {
  if (!username) return null;
  try {
    const posts = await collectProfilePosts(username, { limit: 30 });
    const target = canonicalPostUrl(url);
    const hit = (posts || []).find(p => canonicalPostUrl(p?.url) === target);
    if (!hit) return null;
    return {
      sourceText: String(hit.text || '')
        .replace(/\s+/g, ' ')
        .trim(),
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
// Post detail with a 20-minute cache and a per-URL 15-minute cooldown after Threads answers 429,
// falling back to the author's profile listing while cooling down.
async function collectPostDetails(url, username) {
  const key = canonicalPostUrl(url);
  const cached = threads429DetailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[Threads][429 GUARD] detail cache hit @${username || '-'} url=${key}`);
    return threads429CloneDetail(cached.value);
  }
  if (cached) threads429DetailCache.delete(key);

  if (threads429Guard.isCooling(key)) {
    const remain = threads429Guard.remainingMinutes(key);
    console.warn(
      `[Threads][429 GUARD] 이 URL cooldown ${remain}분 남음 → 상세 직접접근 생략 @${username || '-'} url=${key}`
    );
    const fallback = await threads429ProfileFallback(key, username);
    if (fallback?.sourceText) {
      threads429DetailCache.set(key, {
        expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS,
        value: threads429CloneDetail(fallback),
      });
      return fallback;
    }
    throw new Error(`Threads 웹 요청 제한 cooldown 중입니다 (${remain}분): ${key}`);
  }

  try {
    const result = await collectPostDetailsOnce(url, username);
    if (result)
      threads429DetailCache.set(key, {
        expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS,
        value: threads429CloneDetail(result),
      });
    return result;
  } catch (err) {
    if (!is429Error(err)) throw err;
    threads429Guard.mark429(key);
    const fallback = await threads429ProfileFallback(key, username);
    if (fallback?.sourceText) {
      threads429DetailCache.set(key, {
        expiresAt: Date.now() + THREADS_429_CACHE_TTL_MS,
        value: threads429CloneDetail(fallback),
      });
      return fallback;
    }
    throw err;
  }
}

setInterval(
  () => {
    const now = Date.now();
    for (const [key, item] of threads429DetailCache)
      if (!item || item.expiresAt <= now) threads429DetailCache.delete(key);
    threads429Guard.clearExpired?.();
  },
  10 * 60 * 1000
).unref?.();

// Opt-in startup diagnostics (THREADS_STARTUP_DIAGNOSTICS=1), run in the browser worker.
function startThreadsDiagnosticsIfEnabled() {
  if (process.env.THREADS_STARTUP_DIAGNOSTICS !== '1') return;
  setImmediate(() => scraper('runThreadsAccessDiag').catch(() => {}));
}

module.exports = {
  collectBenchmarkMaterials,
  collectProfilePosts,
  collectPostDetails,
  startThreadsDiagnosticsIfEnabled,
};
