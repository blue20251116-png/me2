'use strict';
const { isAiBudgetOrCreditError } = require('../integrations/aiRequestGuard');
// Autopilot controller: every 10 minutes, for each enabled account, keep a small buffer of future
// scheduled posts filled by running the generation pipeline (or the content-only recipe path for
// accounts without Coupang keys), attaching media and the affiliate link, and saving the post.
const cron = require('node-cron');
const fs = require('fs');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('../config/paths');
const { publicUploadUrl } = require('../config/publicUrl');
const { db, getAccount, getUserById } = require('../infra/db');
const coupangApi = require('../integrations/coupangApi');
const { generateRecipe: generateContentOnlyRecipe, generateDailyStory } = require('../content/contentOnlyAutomation');
const { accountPersonaFor, bannedPhrasesFor, accountPersonaSettings, personaCapsFor } = require('../content/accountPersonas');
const accountMix = require('./accountMix');
const { buildAutopilotPost } = require('./pipeline');
const { materialHasVideo } = require('./materials');
const { importThreadsVideo } = require('../threads/mediaImporter');
const { encodeMediaBundle } = require('../threads/mediaBundle');
const { isTokenExpired } = require('../threads/tokenRefresh');
const { getBrowserCircuitState, browserInfraFailure } = require('../infra/isolatedTask');
const { setState, budgetState } = require('../infra/automationState');
const { hasCoupangKeys } = require('../publish/commentText');
const {
  targetForAccount,
  futurePendingCount,
  chooseFutureSlots,
  rebalanceExistingFuturePending,
} = require('../publish/slots');

function formatThreadsBody(text) {
  return require('../content/voicePolicy').formatVoice(text);
}

const uploadsDir = UPLOADS_DIR;
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const AUTOPILOT_TARGETS = ['전체', '20대 여자', '20대 남자', '30대 여자', '30대 남자', '40대 이상'];
function saveAutopilotPost({
  accountId,
  text,
  link,
  imageUrl,
  extraImageUrl,
  videoUrl = null,
  recipeCommentText = null,
  scheduledAt = null,
  persona = null,
  contentMode = null,
  dedupeKeys = null,
  postFrame = null,
  videoSkipReason = null,
  videoDurationSec = null,
  guard = null,
}) {
  const formattedText = formatThreadsBody(text);
  // guard (owner accounts, dev 0079f189): re-checks the day caps right before the INSERT inside one
  // IMMEDIATE transaction, so another process or a concurrent generation cannot slip in between.
  // A non-empty reason returned by guard() skips the insert and is handed back as { skipped }.
  let inTx = false;
  if (guard) {
    db.exec('BEGIN IMMEDIATE');
    inTx = true;
  }
  try {
    const reason = guard ? guard() : null;
    if (reason) {
      db.exec('ROLLBACK');
      inTx = false;
      return { skipped: reason };
    }
    const info = insertAutopilotPost({
      formattedText,
      accountId,
      link,
      imageUrl,
      extraImageUrl,
      videoUrl,
      recipeCommentText,
      scheduledAt,
      persona,
      contentMode,
      dedupeKeys,
      postFrame,
    });
    const id = Number(info?.lastInsertRowid || 0) || null;
    recordVideoMeta(id, videoSkipReason, videoDurationSec);
    if (inTx) {
      db.exec('COMMIT');
      inTx = false;
    }
    return { id };
  } catch (e) {
    if (inTx)
      try {
        db.exec('ROLLBACK');
      } catch {}
    throw e;
  }
}
// Why this post has no video (posts.video_skip_reason) and its video length (posts.video_duration_sec).
// Best effort: a missing column (migration failed) never blocks the reservation.
function recordVideoMeta(id, videoSkipReason, videoDurationSec) {
  if (!id || (videoSkipReason == null && videoDurationSec == null)) return;
  try {
    db.prepare('UPDATE posts SET video_skip_reason=?, video_duration_sec=? WHERE id=?').run(
      videoSkipReason ? String(videoSkipReason).slice(0, 300) : null,
      Number.isFinite(Number(videoDurationSec)) && videoDurationSec != null ? Number(videoDurationSec) : null,
      id
    );
  } catch (e) {
    console.warn(`[Autopilot][VIDEO META] post=${id} 기록 실패 reason="${e.message}"`);
  }
}
function insertAutopilotPost({
  formattedText,
  accountId,
  link,
  imageUrl,
  extraImageUrl,
  videoUrl,
  recipeCommentText,
  scheduledAt,
  persona,
  contentMode,
  dedupeKeys,
  postFrame,
}) {
  // dedupe_keys is only written for fixed-persona accounts (accountMix.js); every other account keeps
  // the original INSERT unchanged.
  if (dedupeKeys) {
    return db.prepare(
      `INSERT INTO posts (text,link,image_url,extra_image_url,video_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text,comment_retry_count,comment_next_retry_at,persona,content_mode,dedupe_keys,post_frame) VALUES (?,?,?,?,?,?,1,'pending',?,?,0,NULL,?,?,?,?)`
    ).run(
      formattedText,
      link || null,
      imageUrl || null,
      extraImageUrl || null,
      videoUrl || null,
      String(scheduledAt || new Date().toISOString()),
      accountId,
      recipeCommentText,
      persona || null,
      contentMode || null,
      dedupeKeys,
      postFrame || null
    );
  }
  return db.prepare(
    `INSERT INTO posts (text,link,image_url,extra_image_url,video_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text,comment_retry_count,comment_next_retry_at,persona,content_mode) VALUES (?,?,?,?,?,?,1,'pending',?,?,0,NULL,?,?)`
  ).run(
    formattedText,
    link || null,
    imageUrl || null,
    extraImageUrl || null,
    videoUrl || null,
    String(scheduledAt || new Date().toISOString()),
    accountId,
    recipeCommentText,
    persona || null,
    contentMode || null
  );
}
function recordAutopilotLast(accountId, keyword, target) {
  db.prepare(`UPDATE accounts SET autopilot_last_keyword=?, autopilot_last_target=? WHERE id=?`).run(
    keyword,
    target,
    accountId
  );
}
async function runContentOnlyAutopilot(account, target, scheduledAt = null) {
  const r = await generateContentOnlyRecipe(account.id, target);
  saveAutopilotPost({
    accountId: account.id,
    text: r.text,
    link: null,
    imageUrl: r.imageUrl,
    extraImageUrl: r.extraImageUrl,
    videoUrl: null,
    recipeCommentText: r.recipeCommentText,
    scheduledAt,
    persona: r.persona,
    contentMode: 'recipe',
    videoSkipReason: '콘텐츠 전용 경로(쿠팡 키 없음): 레시피 이미지 글은 영상 미사용',
  });
  recordAutopilotLast(account.id, r.keyword, target);
}
// Fixed-persona accounts: the link-free everyday post (no product, no Coupang link).
// 2026-10-14: text-only everyday posts stalled at 1-10 views on these low-follower accounts, so
// one goes out only with a photo attached (generateDailyStory's stock-photo search) and only if it
// does not read like another recent owner-account post. Returns false when no such post could be
// made; the caller then fills the slot with a link-free recipe/product post instead.
// 2026-10-30 (marketing plan 5: reference accounts' top posts are 20% text-only, ours 0%):
// accountPersonas.json dailyWithPhoto=false makes these text-only posts again.
async function runDailyStoryAutopilot(account, target, scheduledAt = null, reservation = null) {
  const withPhoto = accountPersonaSettings().dailyWithPhoto;
  let r;
  try {
    r = await generateDailyStory(account.id, target, { requirePhoto: withPhoto });
  } catch (e) {
    if (isAiBudgetOrCreditError(e)) throw e;
    console.log(
      `[자동발행 예약][PERSONA DAILY] account #${account.id} 생략 → 레시피/상품 글로 대체 reason="${e.message}"`
    );
    return false;
  }
  if (withPhoto && !r?.imageUrl) {
    console.log(`[자동발행 예약][PERSONA DAILY] account #${account.id} 사진 없음 → 레시피/상품 글로 대체`);
    return false;
  }
  const similar = accountMix.findSimilarText(account.id, r.text, scheduledAt);
  if (similar) {
    console.log(
      `[자동발행 예약][PERSONA DAILY] account #${account.id} 비슷한 글 ${similar.scope} #${similar.accountId} post=${similar.postId} score=${similar.score.toFixed(2)} → 레시피/상품 글로 대체`
    );
    return false;
  }
  const saved = saveAutopilotPost({
    accountId: account.id,
    text: r.text,
    link: null,
    imageUrl: withPhoto ? r.imageUrl : null,
    extraImageUrl: null,
    videoUrl: null,
    recipeCommentText: null,
    scheduledAt,
    persona: r.persona,
    contentMode: 'daily',
    videoSkipReason: '일상 글 칸: 텍스트/사진 글이라 영상 미사용',
    guard: () => accountMix.capRecheck(account.id, scheduledAt, { daily: true, own: [reservation] }).daily,
  });
  if (saved?.skipped) {
    console.log(`[자동발행 예약][PERSONA DAILY] account #${account.id} ${saved.skipped} → 레시피/상품 글로 대체`);
    return false;
  }
  recordAutopilotLast(account.id, r.keyword, target);
  console.log(
    `[자동발행 예약][PERSONA DAILY] account #${account.id} persona=${r.persona} link=no photo=${withPhoto ? 'yes' : 'no'}`
  );
  return true;
}
// Link-free recipe posts keep their recipe comment, but the comment written for a linked post hides
// the key ingredient as '비밀 소스/재료' (the link revealed it). Without a link, name it.
function revealSecretIngredient(comment, secretTerm) {
  const term = String(secretTerm || '').trim();
  if (!comment || !term) return comment || null;
  return String(comment).replace(/비밀\s*(?:소스|재료)/g, term);
}
// 2026-09-16 (user request, viral-formula screenshot: "사진과 영상은 꼭 넣으세요"): media is
// reached as missing only when chooseSourceMedia()'s whole fallback chain runs out - no Threads
// source images/video AND no Coupang product image (chooseImageFallback()'s own label calls
// this exact case '미디어 없음'). Same posture as qualityHold.js's QUALITY HOLD:
// don't publish a worse post than the format calls for. CONTENT_QUALITY_HOLD is caught by
// refillAccount's error handler, which stops this account's batch without poisoning any cache -
// the material itself is never marked used, so a later refill tick retries it with a fresh
// media search instead of a permanently lost/skipped topic.
function assertHasMedia(media, { accountId, target, mode, topic } = {}) {
  if (media?.imageUrl || media?.videoUrl) return;
  console.warn(
    `[Autopilot][MEDIA HOLD] account #${accountId} target="${target}" mode="${mode}" topic="${topic}" 미디어 없음 → 발행 보류`
  );
  const err = new Error('소스 이미지/영상이 없어 텍스트 전용 발행을 중단했습니다');
  err.code = 'CONTENT_QUALITY_HOLD';
  err.isContentQualityHold = true;
  throw err;
}
function mediaHasVideo(media) {
  return !!media?.videoUrl || /VIDEO/.test(String(media?.imageUrl || ''));
}
// 2026-11-07 owner ("스레드 영상없는거 올리지 말랫는데", then "일상글은 그냥쓰되 쿠파스 링크달 글은
// 영상잇어야해"): on accounts with accounts.require_video_for_link=1 a post that carries the Coupang
// link must carry a video. Without one the slot is skipped: no image or text fallback. Everyday posts
// and link-free recipe posts are unchanged.
function linkNeedsVideo(account) {
  return Number(account?.require_video_for_link || 0) === 1;
}
function videoRequiredSkip(account, scheduledAt, reason) {
  console.log(
    `[Autopilot][VIDEO REQUIRED] account #${account?.id} slot=${scheduledAt || '-'} 쿠팡 링크 글인데 영상 없음 (${reason}) → 이 칸 건너뜀`
  );
  const err = new Error(`쿠팡 링크 글은 영상 필수: ${reason} → 칸 건너뜀`);
  err.code = 'VIDEO_REQUIRED_SKIP';
  return err;
}
function chooseImageFallback(result) {
  const images = Array.isArray(result?.sourceImages) ? result.sourceImages.filter(Boolean) : [];
  if (images.length >= 2)
    return {
      videoUrl: null,
      imageUrl: images[0],
      extraImageUrl: images[1],
      imageSourceLabel: 'Threads 소재 원본 이미지 2장',
    };
  if (images.length === 1)
    return {
      videoUrl: null,
      imageUrl: images[0],
      extraImageUrl: null,
      imageSourceLabel: 'Threads 소재 원본 이미지 1장',
    };
  return {
    videoUrl: null,
    imageUrl: result?.product?.image || null,
    extraImageUrl: null,
    imageSourceLabel: result?.product?.image ? 'Threads 미디어 없음 → 쿠팡 상품 이미지 1장' : '미디어 없음',
  };
}
// Owner accounts (2026-10-14): a re-uploaded video only while the day's video cap allows it, and
// product posts lead with the Coupang product image instead of another creator's photo.
function ownerImageFallback(result) {
  const images = Array.isArray(result?.sourceImages) ? result.sourceImages.filter(Boolean) : [];
  const productImage = result?.product?.image || null;
  if (result?.mode === 'product' && productImage)
    return {
      videoUrl: null,
      imageUrl: productImage,
      extraImageUrl: images[0] || null,
      imageSourceLabel: `쿠팡 상품 이미지 1장${images[0] ? ' + Threads 소재 이미지 1장' : ''}`,
    };
  return chooseImageFallback(result);
}
function fileHash(filename) {
  try {
    return crypto
      .createHash('sha1')
      .update(fs.readFileSync(require('path').join(uploadsDir, filename)))
      .digest('hex')
      .slice(0, 20);
  } catch {
    return null;
  }
}
// options (owner accounts only): { allowVideo, accountId, scheduledAt, capReason } - allowVideo=false skips
// the video import; a video whose file another owner post already used (m: key) falls back to images.
// 2026-11-05 (dev 0079f189): the returned media carries videoSkipReason (why this slot got no video; null
// when it has one) and videoDurationSec (length of the imported file), both saved on the post row.
async function chooseSourceMedia(result, options = null) {
  const media = await chooseSourceMediaInner(result, options);
  if (!mediaHasVideo(media) && media.videoSkipReason) {
    const who = options?.accountId ? `account #${options.accountId} ` : '';
    console.log(`[Autopilot][VIDEO SKIP] ${who}slot=${options?.scheduledAt || '-'} reason="${media.videoSkipReason}"`);
  }
  return media;
}
function withReason(media, videoSkipReason) {
  return { ...media, videoSkipReason, videoDurationSec: null };
}
async function chooseSourceMediaInner(result, options = null) {
  const videos = Array.isArray(result?.sourceVideos) ? result.sourceVideos.filter(Boolean) : [];
  const images = Array.isArray(result?.sourceImages) ? result.sourceImages.filter(Boolean) : [];
  const fallback = reason => withReason(options ? ownerImageFallback(result) : chooseImageFallback(result), reason);
  if (!videos.length) return fallback('소재에 영상 없음');
  if (options && !options.allowVideo) {
    console.log(`[Autopilot][VIDEO CAP] account #${options.accountId} 오늘 재업로드 영상 한도 → 이미지 사용`);
    return fallback(options.capReason || '오늘 영상 한도 도달');
  }
  if (result?.sourceUrl) {
    try {
      console.log(`[Autopilot][VIDEO IMPORT] 소재찾기 importer 사용 시작 source=${result.sourceUrl}`);
      const imported = await importThreadsVideo({ url: result.sourceUrl, outputDir: uploadsDir });
      if (options) {
        const mediaHash = fileHash(imported.filename);
        const keys = mediaHash ? accountMix.dedupeKeysFor({ mediaHash }) : [];
        const dup = keys.length ? accountMix.findDuplicate(options.accountId, keys, options.scheduledAt) : null;
        if (dup) {
          console.log(
            `[Autopilot][VIDEO DEDUPE] account #${options.accountId} 같은 영상 파일 ${dup.scope} #${dup.accountId} → 이미지 사용`
          );
          return withReason(ownerImageFallback(result), `같은 영상 파일을 이미 씀 (${dup.scope} #${dup.accountId})`);
        }
        result.mediaKeys = keys;
      }
      const videoDurationSec = require('../threads/videoDuration').probeVideoDurationSec(
        require('path').join(uploadsDir, imported.filename)
      );
      const videoUrl = publicUploadUrl(imported.filename);
      const items = [{ type: 'VIDEO', url: videoUrl }, ...images.slice(0, 9).map(url => ({ type: 'IMAGE', url }))];
      const bundle = encodeMediaBundle(items);
      console.log(
        `[Autopilot][VIDEO IMPORT] 성공 file=${imported.filename} size=${imported.size} method=${imported.extractionMethod} images=${images.length} bundleItems=${items.length}`
      );
      if (bundle && items.length > 1)
        return {
          videoUrl: null,
          imageUrl: bundle,
          extraImageUrl: null,
          imageSourceLabel: `Threads 소재 원본 영상 1개 + 이미지 ${Math.min(images.length, 9)}개`,
          videoSkipReason: null,
          videoDurationSec,
        };
      return {
        videoUrl,
        imageUrl: null,
        extraImageUrl: null,
        imageSourceLabel: 'Threads 소재 원본 영상 다운로드 1개',
        videoSkipReason: null,
        videoDurationSec,
      };
    } catch (err) {
      console.warn(
        `[Autopilot][VIDEO IMPORT] 실패 → 이미지 fallback source=${result.sourceUrl} reason="${err.message}"`
      );
      return fallback(`영상 다운로드 실패: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  return fallback('영상 원본 주소 없음');
}
function classifyCoupangUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const host = u.hostname.toLowerCase();
    const alreadyAffiliate =
      host === 'link.coupang.com' || host.endsWith('.link.coupang.com') || /lptag|subid|aff/i.test(u.search);
    const plainCoupang = host === 'coupang.com' || host === 'www.coupang.com' || host.endsWith('.coupang.com');
    return { valid: /^https?:$/i.test(u.protocol), alreadyAffiliate, plainCoupang, host };
  } catch {
    return { valid: false, alreadyAffiliate: false, plainCoupang: false, host: '' };
  }
}
async function makeAffiliateLink(account, result) {
  const raw = String(result?.product?.url || '').trim();
  if (!raw) throw new Error('쿠팡 상품 URL이 비어 있어 자동발행을 중단했습니다');
  const info = classifyCoupangUrl(raw);
  if (!info.valid || !info.plainCoupang)
    throw new Error(`쿠팡 상품 URL 형식이 올바르지 않습니다: ${raw.slice(0, 120)}`);
  if (info.alreadyAffiliate) {
    console.log(`[Coupang][LINK] 이미 파트너스 링크라 딥링크 변환 생략 host=${info.host}`);
    return raw;
  }
  try {
    const links = await coupangApi.createDeeplink(account.id, [raw]);
    const first = Array.isArray(links) ? links[0] : null;
    const affiliate = String(first?.shortenUrl || first?.landingUrl || first?.originalUrl || '').trim();
    if (!affiliate) throw new Error('쿠팡 파트너스 링크 생성 결과가 비어 있습니다');
    console.log(`[Coupang][LINK] 일반 상품 URL → 딥링크 변환 성공`);
    return affiliate;
  } catch (err) {
    const msg = String(err?.message || err?.response?.data?.rMessage || '');
    if (/url convert failed/i.test(msg)) {
      // dev 936a5d23 (11/05): never post the plain product URL. Drop this product; the slot retries in 10 min
      // and the generation filter skips it, so another product is picked.
      accountMix.markLinkRejected(result?.product);
      console.warn(`[Coupang][LINK] 딥링크 변환 거부 → 이 상품은 버리고 다음 시도에서 다른 상품 사용`);
      const e = new Error('쿠팡 딥링크 변환 거부(url convert failed): 이 상품은 건너뛰고 다른 상품으로 다시 시도');
      e.code = 'COUPANG_LINK_REJECTED';
      throw e;
    }
    throw err;
  }
}
// ---------- 미래 예약 슬롯 기반 타임드 프리필 컨트롤러 (account-stagger v5) ----------
const AUTOPILOT_TIMED_BUFFER = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BUFFER || 3));
const AUTOPILOT_TIMED_BATCH = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BATCH || 2));
const AUTOPILOT_REFILL_CRON = String(process.env.AUTOPILOT_TIMED_REFILL_CRON || '*/10 * * * *');
const COUPANG_PREFLIGHT_TTL_MS = Math.max(
  10 * 60000,
  Number(process.env.COUPANG_PREFLIGHT_TTL_MS || 6 * 60 * 60 * 1000)
);
// An auth failure must recover without restarting the process. Retry on a later refill tick.
const __coupangInvalidTtl = Number(process.env.COUPANG_INVALID_TTL_MS || 5 * 60000);
const COUPANG_INVALID_TTL_MS = Number.isFinite(__coupangInvalidTtl)
  ? Math.min(10 * 60000, Math.max(60000, __coupangInvalidTtl))
  : 5 * 60000;
const autopilotRunningAccounts = new Set();
const coupangPreflightCache = new Map();
let autopilotRefillTickRunning = false;
let autopilotLastAccountId = 0;
// A single account's refill must never be able to hang the whole tick forever (e.g. a browser
// task deep in collectBenchmarkMaterials that never settles) - that would leave
// autopilotRefillTickRunning stuck true, and since cron itself is also forced to noOverlap, no
// future tick could ever run again until the process restarts. This bounds every account to a
// hard ceiling so the tick - and therefore the whole scheduler - always completes.
const ACCOUNT_REFILL_TIMEOUT_MS = Math.max(60000, Number(process.env.AUTOPILOT_ACCOUNT_TIMEOUT_MS || 6 * 60000));
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'AUTOPILOT_ACCOUNT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function credentialFingerprint(account) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        String(account?.coupang_access_key || '').trim(),
        String(account?.coupang_secret_key || '').trim(),
      ])
    )
    .digest('hex');
}
function isCoupangAuthError(err) {
  // A 401 from Claude, Threads, or a media URL is not a Coupang credential failure.
  let fromCoupang = err?.service === 'coupang';
  try {
    const config = err?.config || err?.response?.config;
    fromCoupang ||= new URL(config?.url, config?.baseURL).hostname === 'api-gateway.coupang.com';
  } catch {}
  if (!fromCoupang) return false;
  const status = Number(err?.response?.status || 0);
  const data = err?.response?.data;
  const msg = String(data?.message || data?.rMessage || err?.message || '');
  return (
    status === 401 ||
    String(data?.rCode) === '401' ||
    /invalid signature|unauthorized|invalid.*(?:access.?key|secret.?key)/i.test(msg)
  );
}
async function ensureCoupangReady(accountId, account) {
  if (Number(accountId) === 15) {
    console.warn('[Autopilot][COUPANG PREFLIGHT] account #15 quarantined: known invalid signature');
    setState(accountId, 'blocked', 'ME2_ACCOUNT_15_QUARANTINED');
    return false;
  }
  const fp = credentialFingerprint(account);
  if (!coupangApi.hasCredentials(account)) {
    coupangPreflightCache.set(accountId, {
      ok: false,
      reason: 'missing_credentials',
      fp,
      until: Date.now() + COUPANG_INVALID_TTL_MS,
    });
    console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} API 키 없음 → AI/Vision 생성 건너뜀`);
    return false;
  }
  const cached = coupangPreflightCache.get(accountId);
  if (cached && cached.fp === fp && cached.until > Date.now()) {
    if (!cached.ok)
      console.warn(
        `[Autopilot][COUPANG PREFLIGHT] account #${accountId} cached-invalid reason=${cached.reason} → AI/Vision 생성 건너뜀`
      );
    return cached.ok;
  }
  try {
    // Claude보다 먼저 실제 서명 요청 1회로 인증 상태를 검증한다. 정상 결과는 장시간 캐시한다.
    await coupangApi.searchProducts(accountId, '물티슈', 1);
    coupangPreflightCache.set(accountId, { ok: true, reason: 'ok', fp, until: Date.now() + COUPANG_PREFLIGHT_TTL_MS });
    console.log(
      `[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH OK ttl=${Math.round(COUPANG_PREFLIGHT_TTL_MS / 3600000)}h`
    );
    return true;
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    const msg = String(err?.response?.data?.message || err?.response?.data?.rMessage || err?.message || err || '');
    if (isCoupangAuthError(err)) {
      coupangPreflightCache.set(accountId, {
        ok: false,
        reason: 'invalid_signature',
        fp,
        until: Date.now() + COUPANG_INVALID_TTL_MS,
      });
      console.error(
        `[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH INVALID → AI/Vision 생성 중단 reason="${msg.slice(0, 160)}"`
      );
      return false;
    }
    // 호출 제한/일시 장애는 인증 실패로 오판하지 않는다.
    console.warn(
      `[Autopilot][COUPANG PREFLIGHT] account #${accountId} check deferred status=${status || '-'} reason="${msg.slice(0, 160)}"`
    );
    return true;
  }
}
// Owner accounts: every slot holds an in-flight reservation of its kind (and of a video) while it is being
// generated, so a concurrent generation of the same account-day counts it (dev 0079f189).
async function runAutopilotOnceInner(account, scheduledAt = null) {
  const reservations = [];
  try {
    return await runAutopilotOnceReserved(account, scheduledAt, reservations);
  } finally {
    for (const r of reservations) r.release();
  }
}
async function runAutopilotOnceReserved(account, scheduledAt, reservations) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];
  // Fixed-persona owner accounts alternate link-free everyday posts with a capped number of linked
  // posts per day (accountMix.decideSlotKind); every other account skips this (persona = null).
  const persona = accountPersonaFor(account.id);
  const hold = k => {
    const r = accountMix.reserveSlot(account.id, scheduledAt, k);
    reservations.push(r);
    return r;
  };
  // 'linked' | 'unlinked' | 'daily' for owner accounts (accountMix.decideSlotKind), null otherwise.
  let kind = persona ? accountMix.slotKind(account.id, scheduledAt) : null;
  if (kind === 'daily') {
    const dailyHold = hold('daily');
    if (await runDailyStoryAutopilot(account, target, scheduledAt, dailyHold)) return;
    dailyHold.release();
    kind = 'unlinked';
  }
  if (persona) hold(kind === 'linked' ? 'linked' : 'plain');
  if (!hasCoupangKeys(account)) {
    await runContentOnlyAutopilot(account, target, scheduledAt);
    return;
  }
  const cooldown = coupangApi.getApiCooldown?.(account.id);
  if (cooldown) {
    const e = new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`);
    e.code = 'COUPANG_RATE_LIMIT';
    e.isCoupangRateLimit = true;
    throw e;
  }
  const needVideo = linkNeedsVideo(account);
  // A 'linked' slot always carries the Coupang link: on a video-required account it is skipped up front
  // when the day's video cap is already reached (no generation spent on a post that cannot go out).
  if (needVideo && kind === 'linked' && !accountMix.videoAllowed(account.id, scheduledAt))
    throw videoRequiredSkip(
      account,
      scheduledAt,
      `오늘 영상 한도 ${accountMix.videoPostsOnDay(account.id, scheduledAt)}/${personaCapsFor(account.id).maxVideoPerDay}`
    );
  // dev 0079f189 (b): while the day's video cap allows a video, video source posts are tried first.
  const preferVideo = (!!persona || needVideo) && accountMix.videoAllowed(account.id, scheduledAt);
  // Accounts without a fixed persona still skip products whose deeplink was refused (dev 936a5d23).
  const filters = persona
    ? accountMix.generationFilters(account.id, scheduledAt)
    : { productFilter: accountMix.linkRejectFilter };
  if (needVideo && kind === 'linked') {
    // Linked slot on a video-required account: only sources that carry a video are used.
    const base = filters.materialFilter;
    filters.materialFilter = m =>
      materialHasVideo(m) ? (typeof base === 'function' ? base(m) : null) : '영상 없는 소재 (쿠팡 링크 글은 영상 필수)';
  }
  const result = await buildAutopilotPost(account.id, {
    target,
    ...(preferVideo ? { preferVideo: true } : {}),
    ...filters,
  });
  let dedupeKeys = null;
  if (persona) {
    // Later stages (secret affiliate, source-exact product) may swap the product: re-check the final one.
    const keys = accountMix.dedupeKeysFor({
      product: result.product,
      sourceUrl: result.sourceUrl,
      topic: result.topic,
      searchTerm: result.productSearchTerm,
    });
    const dup = accountMix.findDuplicate(account.id, keys, scheduledAt);
    if (dup) throw accountMix.duplicateError(dup);
    const similar = accountMix.findSimilarText(account.id, result.text, scheduledAt);
    if (similar) throw accountMix.duplicateError(similar);
    result.text = require('../content/voicePolicy').assertVoice(result.text, {
      mode: result.mode,
      bannedPhrases: bannedPhrasesFor(account.id, result.persona),
      // Framed posts: re-check store/authority/price against the FINAL product (a later stage may swap it).
      ...(result.postFrame
        ? {
            frame: result.postFrame,
            grounding: {
              evidence: [result.sourceText, result.authorReplies, result.product?.name].filter(Boolean).join('\n'),
              price: Number(result.product?.price) > 0 ? Number(result.product.price) : null,
            },
          }
        : {}),
    });
    dedupeKeys = accountMix.encodeKeys(keys);
  }
  // Owner accounts' 'unlinked' slots: only a RECIPE may go out without the Coupang link (it keeps its
  // recipe comment with the key ingredient named). A product post always gets its Partners link in the
  // comment (accountMix.linkFreeAllowed, 2026-10-21) - it is never queued without one.
  const unlinked = accountMix.linkFreeAllowed(kind, result.mode);
  const affiliateLink = unlinked ? null : await makeAffiliateLink(account, result);
  if (!unlinked && !affiliateLink) throw new Error('쿠팡 파트너스 링크가 비어 있어 예약을 만들지 않았습니다');
  // The post carries the Coupang link on a video-required account: video or nothing.
  const videoRequired = needVideo && !!affiliateLink;
  let mediaOptions = null;
  let videoHold = null;
  if (persona || videoRequired) {
    const allowVideo = accountMix.videoAllowed(account.id, scheduledAt);
    const capReason = allowVideo
      ? null
      : `오늘 영상 한도 ${accountMix.videoPostsOnDay(account.id, scheduledAt)}/${personaCapsFor(account.id).maxVideoPerDay}`;
    if (videoRequired && !allowVideo) throw videoRequiredSkip(account, scheduledAt, capReason);
    if (allowVideo && persona) videoHold = hold('video');
    mediaOptions = { allowVideo, accountId: account.id, scheduledAt, capReason };
  }
  let media = await chooseSourceMedia(result, mediaOptions);
  if (videoHold && !mediaHasVideo(media)) videoHold.release();
  if (videoRequired && !mediaHasVideo(media))
    throw videoRequiredSkip(account, scheduledAt, media.videoSkipReason || '영상 없음');
  assertHasMedia(media, { accountId: account.id, target, mode: result.mode, topic: result.topic });
  if (persona && result.mediaKeys?.length)
    dedupeKeys = accountMix.encodeKeys([...accountMix.decodeKeys(dedupeKeys), ...result.mediaKeys]);
  const save = m =>
    saveAutopilotPost({
      accountId: account.id,
      text: result.text,
      link: affiliateLink,
      imageUrl: m.imageUrl,
      extraImageUrl: m.extraImageUrl,
      videoUrl: m.videoUrl,
      recipeCommentText: unlinked
        ? result.mode === 'recipe'
          ? revealSecretIngredient(result.commentLead, result.secretTerm)
          : null
        : result.commentLead,
      scheduledAt,
      persona: result.persona,
      contentMode: unlinked ? `${result.mode}-nolink` : result.mode,
      dedupeKeys,
      postFrame: persona ? result.postFrame || null : null,
      videoSkipReason: mediaHasVideo(m) ? null : m.videoSkipReason || null,
      videoDurationSec: mediaHasVideo(m) ? m.videoDurationSec ?? null : null,
      guard:
        persona && mediaHasVideo(m)
          ? () => accountMix.capRecheck(account.id, scheduledAt, { video: true, own: reservations }).video
          : null,
    });
  const saved = save(media);
  if (saved?.skipped) {
    // Video-required linked post: never swapped for images, the slot is skipped.
    if (videoRequired) throw videoRequiredSkip(account, scheduledAt, saved.skipped);
    // Another generation filled the day's video cap meanwhile: same post with the source images instead.
    console.log(`[Autopilot][VIDEO CAP] account #${account.id} ${saved.skipped} → 이미지 사용`);
    media = withReason(ownerImageFallback(result), saved.skipped);
    assertHasMedia(media, { accountId: account.id, target, mode: result.mode, topic: result.topic });
    save(media);
  }
  const last = result.productSearchTerm || result.secretTerm || result.topic;
  recordAutopilotLast(account.id, last, target);
  console.log(
    `[자동발행 예약][V15 MATERIAL-MIXED-MEDIA] account #${account.id} target="${target}" mode="${result.mode}" topic="${result.topic}" product="${result.product.name}" source="${result.sourceUrl}" media="${media.imageSourceLabel}" affiliateLink=${affiliateLink ? 'yes' : 'no'}`
  );
}
// Prevents one Chromium resource failure from being multiplied across every account in the same
// refill tick - a distinct fatal-for-this-tick error lets the timed-prefill controller stop
// account traversal instead of retrying every remaining account against a browser that's already down.
async function runAutopilotOnce(account, scheduledAt = null) {
  const circuit = getBrowserCircuitState();
  if (circuit.open) {
    const err = new Error(`Browser circuit open; retry after ${circuit.retryAfterMs}ms`);
    err.code = 'BROWSER_CIRCUIT_OPEN';
    err.retryAfterMs = circuit.retryAfterMs;
    throw err;
  }
  try {
    return await runAutopilotOnceInner(account, scheduledAt);
  } catch (err) {
    if (browserInfraFailure(err)) {
      err.code = err.code || 'BROWSER_INFRA_FAILURE';
      err.stopAutopilotTick = true;
    }
    throw err;
  }
}
async function refillAccount(accountId) {
  if (autopilotRunningAccounts.has(accountId)) return;
  const account = getAccount(accountId);
  if (!account?.autopilot_enabled) return;
  if (!String(account.threads_access_token || '').trim() || isTokenExpired(account)) {
    setState(accountId, 'blocked', 'THREADS_TOKEN_MISSING');
    console.warn(`[Autopilot][PREFLIGHT] account #${accountId} THREADS_TOKEN_MISSING → 생성 생략`);
    return;
  }
  if (account.user_id) {
    const user = getUserById(account.user_id);
    if (!user || user.status !== 'active' || (user.expires_at && Date.parse(user.expires_at) <= Date.now())) {
      setState(accountId, 'blocked', 'SUBSCRIPTION_INACTIVE');
      return;
    }
  }
  const future = futurePendingCount(accountId);
  const need = Math.min(AUTOPILOT_TIMED_BATCH, Math.max(0, AUTOPILOT_TIMED_BUFFER - future));
  if (!need) return;
  const target = targetForAccount(account);
  const slots = chooseFutureSlots(accountId, target, need);
  if (!slots.length) return;

  // 핵심: Coupang 인증을 AI/Vision보다 먼저 확인한다.
  const coupangReady = await ensureCoupangReady(accountId, account);
  if (!coupangReady) {
    setState(accountId, 'blocked', 'COUPANG_CREDENTIALS_INVALID');
    return;
  }

  autopilotRunningAccounts.add(accountId);
  setState(accountId, 'running', 'generating');
  console.log(
    `[Autopilot][TIMED PREFILL] account #${accountId} target=${target}/day future=${future} preparing=${slots.length}`
  );
  try {
    for (const slot of slots) {
      const budget = budgetState();
      if (!budget.available) {
        setState(accountId, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
        break;
      }
      try {
        // Calls through module.exports (not the bare local reference) so a test can substitute a
        // fake generator to exercise refillAccount's own preflight/retry/circuit logic in
        // isolation from the real generation pipeline - see test/autopilotRunner.test.js.
        await module.exports.runAutopilotOnce(account, slot.toISOString());
        setState(accountId, 'ready', 'reserved');
        console.log(`[Autopilot][TIMED PREFILL] RESERVED account #${accountId} scheduled=${slot.toISOString()}`);
      } catch (err) {
        const status = Number(err?.response?.status || 0);
        console.error(
          `[Autopilot][TIMED PREFILL] generation failed account #${accountId}:`,
          err?.response?.data || err?.message || err
        );
        setState(
          accountId,
          'retry',
          String(err?.code || 'GENERATION_FAILED'),
          new Date(Date.now() + 10 * 60000).toISOString()
        );
        if (isCoupangAuthError(err)) {
          coupangPreflightCache.set(accountId, {
            ok: false,
            reason: 'invalid_signature',
            fp: credentialFingerprint(account),
            until: Date.now() + COUPANG_INVALID_TTL_MS,
          });
          console.error(
            `[Autopilot][COUPANG PREFLIGHT] account #${accountId} runtime AUTH INVALID → 남은 슬롯 중단 + 다음 계정 이동`
          );
          break;
        }
        // Stop this account's batch, but never poison the Coupang auth cache.
        if (
          status === 401 ||
          err?.isContentQualityHold ||
          err?.code === 'CONTENT_QUALITY_HOLD' ||
          isAiBudgetOrCreditError(err)
        )
          break;
        console.log(`[Autopilot][TIMED PREFILL] account #${accountId} 실패 1건은 건너뛰고 다음 예약 슬롯 계속 시도`);
      }
    }
  } finally {
    autopilotRunningAccounts.delete(accountId);
  }
}
function startAutopilotJob() {
  const tick = async () => {
    if (autopilotRefillTickRunning) return;
    autopilotRefillTickRunning = true;
    const startedAt = Date.now();
    setState(0, 'running', 'refill');
    try {
      const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
      // Resume after the last attempted account instead of starving later accounts.
      const ordered = [
        ...accounts.filter(r => Number(r.id) > autopilotLastAccountId),
        ...accounts.filter(r => Number(r.id) <= autopilotLastAccountId),
      ];
      // A single account can legitimately run for up to ACCOUNT_REFILL_TIMEOUT_MS (6 minutes) via
      // withTimeout(), so this check runs BEFORE starting each account and budgets for that
      // account's worst-case duration up front - the tick can never run longer than
      // TICK_TIME_BUDGET_MS in total, keeping it well inside the 10-minute cron interval.
      // AUTOPILOT_TICK_BUDGET_MS lifts this for slow backends (claude-cli): a longer tick only makes
      // the noOverlap cron skip runs, and it must exceed ACCOUNT_REFILL_TIMEOUT_MS or no account runs.
      const TICK_TIME_BUDGET_MS = Math.max(8 * 60000, Number(process.env.AUTOPILOT_TICK_BUDGET_MS) || 0);
      // AUTOPILOT_ACCOUNT_CONCURRENCY (default 1) refills that many accounts in parallel - the local
      // PC has room Railway did not; pair it with PLAYWRIGHT_MAX_CONCURRENCY / CLAUDE_CLI_CONCURRENCY.
      const queue = [...ordered];
      let stop = false;
      const worker = async () => {
        while (!stop && queue.length) {
          const budget = budgetState();
          if (!budget.available) {
            setState(0, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
            console.log(`[Autopilot][BUDGET WAIT] retryAt=${new Date(budget.retryAt).toISOString()}`);
            stop = true;
            return;
          }
          if (Date.now() - startedAt + ACCOUNT_REFILL_TIMEOUT_MS > TICK_TIME_BUDGET_MS) return;
          const accountId = Number(queue.shift().id);
          autopilotLastAccountId = accountId;
          try {
            await withTimeout(
              refillAccount(accountId),
              ACCOUNT_REFILL_TIMEOUT_MS,
              `account #${accountId} refill exceeded ${ACCOUNT_REFILL_TIMEOUT_MS}ms`
            );
          } catch (err) {
            // 2026-11-11 (dev a9b0a750): the reason itself (e.g. CLAUDE_CLI_LIMIT: ...), and the newest one on row -2 for /healthz
            const why = `${err.code || 'PREFLIGHT_FAILED'}: ${String(err.message || '').slice(0, 200)}`;
            setState(accountId, 'retry', why);
            try { setState(-2, 'error', `#${accountId} ${why}`); } catch {}
            console.error(`[Autopilot][ACCOUNT ERROR] #${accountId}: ${err.message}`);
          }
        }
      };
      const concurrency = Math.max(1, Number(process.env.AUTOPILOT_ACCOUNT_CONCURRENCY) || 1);
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (stop) return;
      setState(0, 'idle', 'refill complete');
    } finally {
      autopilotRefillTickRunning = false;
      console.log(
        `[Autopilot][TICK COMPLETE] durationMs=${Date.now() - startedAt} lastAccount=${autopilotLastAccountId}`
      );
    }
  };
  try {
    rebalanceExistingFuturePending();
  } catch (err) {
    console.warn('[Autopilot][TIMED REBALANCE] startup skipped:', err.message);
  }
  cron.schedule(
    AUTOPILOT_REFILL_CRON,
    () => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] tick:', e.message)),
    { timezone: 'Asia/Seoul', noOverlap: true }
  );
  setTimeout(() => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] startup:', e.message)), 3000);
  console.log(
    `[Autopilot][TIMED PREFILL] ON buffer=${AUTOPILOT_TIMED_BUFFER} batch=${AUTOPILOT_TIMED_BATCH} basic=15/day pro=25/day window=24h account-stagger=ON retry-next-slot=ON coupang-preflight=ON cron=${AUTOPILOT_REFILL_CRON}`
  );
}

module.exports = {
  startAutopilotJob,
  runAutopilotOnce,
  refillAccount,
  chooseImageFallback,
  assertHasMedia,
  chooseSourceMedia,
  saveAutopilotPost,
};
