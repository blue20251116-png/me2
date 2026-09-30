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
const { generateRecipe: generateContentOnlyRecipe } = require('../content/contentOnlyAutomation');
const { buildAutopilotPost } = require('./pipeline');
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
}) {
  const formattedText = formatThreadsBody(text);
  db.prepare(
    `INSERT INTO posts (text,link,image_url,extra_image_url,video_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text,comment_retry_count,comment_next_retry_at) VALUES (?,?,?,?,?,?,1,'pending',?,?,0,NULL)`
  ).run(
    formattedText,
    link || null,
    imageUrl || null,
    extraImageUrl || null,
    videoUrl || null,
    String(scheduledAt || new Date().toISOString()),
    accountId,
    recipeCommentText
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
  });
  recordAutopilotLast(account.id, r.keyword, target);
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
async function chooseSourceMedia(result) {
  const videos = Array.isArray(result?.sourceVideos) ? result.sourceVideos.filter(Boolean) : [];
  const images = Array.isArray(result?.sourceImages) ? result.sourceImages.filter(Boolean) : [];
  if (videos.length && result?.sourceUrl) {
    try {
      console.log(`[Autopilot][VIDEO IMPORT] 소재찾기 importer 사용 시작 source=${result.sourceUrl}`);
      const imported = await importThreadsVideo({ url: result.sourceUrl, outputDir: uploadsDir });
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
        };
      return { videoUrl, imageUrl: null, extraImageUrl: null, imageSourceLabel: 'Threads 소재 원본 영상 다운로드 1개' };
    } catch (err) {
      console.warn(
        `[Autopilot][VIDEO IMPORT] 실패 → 이미지 fallback source=${result.sourceUrl} reason="${err.message}"`
      );
    }
  }
  return chooseImageFallback(result);
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
      console.warn(`[Coupang][LINK] 딥링크 재변환 거부 → 검색 API productUrl 그대로 사용`);
      return raw;
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
async function runAutopilotOnceInner(account, scheduledAt = null) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];
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
  const result = await buildAutopilotPost(account.id, { target });
  const affiliateLink = await makeAffiliateLink(account, result);
  const media = await chooseSourceMedia(result);
  assertHasMedia(media, { accountId: account.id, target, mode: result.mode, topic: result.topic });
  saveAutopilotPost({
    accountId: account.id,
    text: result.text,
    link: affiliateLink,
    imageUrl: media.imageUrl,
    extraImageUrl: media.extraImageUrl,
    videoUrl: media.videoUrl,
    recipeCommentText: result.commentLead,
    scheduledAt,
  });
  const last = result.productSearchTerm || result.secretTerm || result.topic;
  recordAutopilotLast(account.id, last, target);
  console.log(
    `[자동발행 예약][V15 MATERIAL-MIXED-MEDIA] account #${account.id} target="${target}" mode="${result.mode}" topic="${result.topic}" product="${result.product.name}" source="${result.sourceUrl}" media="${media.imageSourceLabel}" affiliateLink=yes`
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
      const TICK_TIME_BUDGET_MS = 8 * 60000;
      for (const row of ordered) {
        const budget = budgetState();
        if (!budget.available) {
          setState(0, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
          console.log(`[Autopilot][BUDGET WAIT] retryAt=${new Date(budget.retryAt).toISOString()}`);
          return;
        }
        if (Date.now() - startedAt + ACCOUNT_REFILL_TIMEOUT_MS > TICK_TIME_BUDGET_MS) break;
        autopilotLastAccountId = Number(row.id);
        try {
          await withTimeout(
            refillAccount(autopilotLastAccountId),
            ACCOUNT_REFILL_TIMEOUT_MS,
            `account #${autopilotLastAccountId} refill exceeded ${ACCOUNT_REFILL_TIMEOUT_MS}ms`
          );
        } catch (err) {
          setState(autopilotLastAccountId, 'retry', err.code || 'PREFLIGHT_FAILED');
          console.error(`[Autopilot][ACCOUNT ERROR] #${autopilotLastAccountId}: ${err.message}`);
        }
      }
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

module.exports = { startAutopilotJob, runAutopilotOnce, refillAccount, chooseImageFallback, assertHasMedia };
