const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { db, listAllAccountsForSystem, getAccount, canPublish, findMediaSourceForProduct, markMediaSourceUsed } = require('./db');
const { publishPost, publishCarouselPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateAffiliateLead } = require('./aiSocial');
const { generateRecipe: generateContentOnlyRecipe } = require('./contentOnlyAutomation');
const { buildThreadsFirstAutopilot } = require('./autopilotMaterialEngine');

try { db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`); } catch {}

function hasCoupangKeys(account) {
  return !!(String(account?.coupang_access_key || '').trim() && String(account?.coupang_secret_key || '').trim());
}

function isCoupangLink(link) {
  return /(^|\.)coupang\.com|link\.coupang\.com/i.test(String(link || ''));
}

function isNaverConnectLink(link) {
  try {
    const u = new URL(String(link || '').trim());
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === 'naver.me' || h.endsWith('.naver.me') || h === 'naver.com' || h.endsWith('.naver.com'));
  } catch {
    return false;
  }
}

function buildDisclosureText(account, link) {
  if (!link) return '';
  if (isCoupangLink(link)) return (account.coupang_disclosure_template || '{link}').replace('{link}', link);
  if (isNaverConnectLink(link)) {
    return `네이버 쇼핑 커넥트 활동을 통해 수수료를 제공받을 수 있습니다.\n${String(link).trim()}`;
  }
  return String(link).trim();
}

function trimToLimit(text, limit) {
  const normalized = String(text || '').trim();
  if (normalized.length <= limit) return normalized;
  if (limit <= 1) return normalized.slice(0, Math.max(0, limit));
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function combineCommentSafely(prefixText, disclosure, maxLength = 480) {
  const p = String(prefixText || '').trim();
  const d = String(disclosure || '').trim();
  const sep = p && d ? '\n\n' : '';
  if (!p) return trimToLimit(d, maxLength);
  if (!d) return trimToLimit(p, maxLength);
  const available = maxLength - d.length - sep.length;
  if (available <= 0) return trimToLimit(d, maxLength);
  return `${trimToLimit(p, available)}${sep}${d}`;
}

const uploadsDir = path.join(__dirname, 'uploads');
function localPathFromUploadUrl(url) {
  if (!url) return null;
  const marker = '/uploads/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return path.join(uploadsDir, url.slice(idx + marker.length));
}
function mediaSourceFilesExist(media) {
  const primary = localPathFromUploadUrl(media.image_url);
  if (!primary || !fs.existsSync(primary)) return false;
  if (media.extra_image_url) {
    const extra = localPathFromUploadUrl(media.extra_image_url);
    if (!extra || !fs.existsSync(extra)) return false;
  }
  return true;
}

async function buildCommentText(account, post) {
  const disclosure = buildDisclosureText(account, post.link);
  if (post.recipe_comment_text) return combineCommentSafely(post.recipe_comment_text, disclosure, 480);
  if (!post.link) return '';
  try {
    const lead = await generateAffiliateLead(account.id, { postText: post.text });
    if (lead) return combineCommentSafely(lead, disclosure, 480);
  } catch (err) {
    console.error(`[댓글 연결문구 생성 실패, 링크만 사용] account #${account.id} post #${post.id}:`, err.message);
  }
  return trimToLimit(disclosure, 480);
}

async function postAffiliateComment(account, post, parentMediaId) {
  if (!post.auto_comment_enabled) return;
  if (!post.link && !post.recipe_comment_text) return;
  try {
    const commentText = await buildCommentText(account, post);
    if (!commentText) return;
    console.log(`[댓글 길이] account #${account.id} post #${post.id}: ${commentText.length}자`);
    const commentMediaId = await publishReply(account.id, parentMediaId, commentText);
    db.prepare(`UPDATE posts SET comment_status='posted', comment_media_id=?, comment_posted_at=? WHERE id=?`).run(commentMediaId, new Date().toISOString(), post.id);
    console.log(`[댓글 등록 완료] account #${account.id} post #${post.id} -> comment ${commentMediaId}`);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    db.prepare(`UPDATE posts SET comment_status='failed', comment_error_message=? WHERE id=?`).run(msg, post.id);
    console.error(`[댓글 등록 실패] account #${account.id} post #${post.id}:`, msg);
  }
}

function startPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    for (const accountSummary of listAllAccountsForSystem()) {
      const account = getAccount(accountSummary.id);
      const duePosts = db.prepare(`SELECT * FROM posts WHERE account_id=? AND status='pending' AND scheduled_at<=? ORDER BY scheduled_at ASC`).all(account.id, now);
      for (const post of duePosts) {
        if (account.user_id && !canPublish(account.user_id)) {
          db.prepare(`UPDATE posts SET status='failed', error_message=? WHERE id=?`).run('오늘 발행 가능 횟수를 다 썼습니다 (요금제 하루 한도 초과)', post.id);
          continue;
        }
        try {
          let mediaId;
          if (post.image_url && post.extra_image_url) mediaId = await publishCarouselPost(account.id, { text: post.text, imageUrls: [post.image_url, post.extra_image_url] });
          else mediaId = await publishPost(account.id, { text: post.text, imageUrl: post.image_url, videoUrl: post.video_url });
          db.prepare(`UPDATE posts SET status='posted', threads_media_id=?, posted_at=? WHERE id=?`).run(mediaId, new Date().toISOString(), post.id);
          db.prepare(`INSERT INTO insights (post_id,views,likes,replies,reposts,quotes) VALUES (?,0,0,0,0,0) ON CONFLICT(post_id) DO NOTHING`).run(post.id);
          console.log(`[발행 완료] account #${account.id} post #${post.id} -> media ${mediaId}`);
          await new Promise(r => setTimeout(r, 3000));
          await postAffiliateComment(account, post, mediaId);
        } catch (err) {
          const apiErr = err.response?.data?.error;
          const msg = apiErr ? `${apiErr.message} (type: ${apiErr.type || '-'}, code: ${apiErr.code || '-'}${apiErr.error_subcode ? ', subcode: ' + apiErr.error_subcode : ''})` : err.message;
          db.prepare(`UPDATE posts SET status='failed', error_message=? WHERE id=?`).run(msg, post.id);
          console.error(`[발행 실패] account #${account.id} post #${post.id}:`, msg);
        }
      }
    }
  });
}

function startInsightsJob() {
  cron.schedule('*/10 * * * *', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    for (const accountSummary of listAllAccountsForSystem()) {
      const postedToday = db.prepare(`SELECT * FROM posts WHERE account_id=? AND status='posted' AND posted_at>=? AND threads_media_id IS NOT NULL`).all(accountSummary.id, startOfDay.toISOString());
      for (const post of postedToday) {
        try {
          const stats = await getMediaInsights(accountSummary.id, post.threads_media_id);
          db.prepare(`INSERT INTO insights (post_id,views,likes,replies,reposts,quotes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,updated_at=excluded.updated_at`).run(post.id, stats.views || 0, stats.likes || 0, stats.replies || 0, stats.reposts || 0, stats.quotes || 0, new Date().toISOString());
        } catch (err) {
          console.error(`[인사이트 갱신 실패] account #${accountSummary.id} post #${post.id}:`, err.response?.data || err.message);
        }
      }
    }
  });
}

function randomIntervalMinutes() { return 60 + Math.random() * 15; }
const AUTOPILOT_TARGETS = ['전체', '20대 여자', '20대 남자', '30대 여자', '30대 남자', '40대 이상'];

function saveAutopilotPost({ accountId, text, link, imageUrl, extraImageUrl, recipeCommentText = null }) {
  db.prepare(`INSERT INTO posts (text,link,image_url,extra_image_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text) VALUES (?,?,?,?,?,1,'pending',?,?)`).run(text, link || null, imageUrl || null, extraImageUrl || null, new Date().toISOString(), accountId, recipeCommentText);
}

function recordAutopilotLast(accountId, keyword, target) {
  db.prepare(`UPDATE accounts SET autopilot_last_keyword=?, autopilot_last_target=? WHERE id=?`).run(keyword, target, accountId);
}

async function runContentOnlyAutopilot(account, target) {
  const r = await generateContentOnlyRecipe(account.id, target);
  saveAutopilotPost({ accountId: account.id, text: r.text, link: null, imageUrl: r.imageUrl, extraImageUrl: r.extraImageUrl, recipeCommentText: r.recipeCommentText });
  recordAutopilotLast(account.id, r.keyword, target);
  console.log(`[자동발행 예약] account #${account.id} mode="recipe-no-commerce" target="${target}" keyword="${r.keyword}" (${r.trendNote}) image="${r.imageSourceLabel}"`);
}

function chooseProductMedia(account, product) {
  let imageUrl = product?.image || null;
  let extraImageUrl = null;
  let imageSourceLabel = product?.image ? '쿠팡 원본 상품컷 1장' : '없음';

  if (account.autopilot_frame_media_enabled && product?.name) {
    try {
      const media = findMediaSourceForProduct(account.id, product.name);
      if (media && mediaSourceFilesExist(media)) {
        imageUrl = media.image_url;
        extraImageUrl = media.extra_image_url || null;
        markMediaSourceUsed(media.id);
        imageSourceLabel = extraImageUrl ? '저장 프레임 2장' : '저장 프레임 1장';
      }
    } catch (err) {
      console.log(`[Media] 저장 프레임 조회 실패 — 쿠팡 상품 이미지 유지: ${err.message}`);
    }
  }

  return { imageUrl, extraImageUrl, imageSourceLabel };
}

async function runAutopilotOnce(account) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];

  if (!hasCoupangKeys(account)) {
    console.log(`[Autopilot][NO COUPANG] account=${account.id} 쿠팡 API 키 없음 → 순수 레시피 모드`);
    await runContentOnlyAutopilot(account, target);
    return;
  }

  const cooldown = coupangApi.getApiCooldown?.(account.id);
  if (cooldown) {
    const err = new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`);
    err.code = 'COUPANG_RATE_LIMIT';
    err.isCoupangRateLimit = true;
    throw err;
  }

  // V3: 무조건 Threads 소재가 1순위다.
  // Threads 소재 → 원문/작성자댓글 분석 → 핵심 상품/재료 추출 → 쿠팡 검색 → 소재 기반 글 → 댓글에 상품+제휴링크.
  const result = await buildThreadsFirstAutopilot(account.id, { target });
  const media = chooseProductMedia(account, result.product);

  saveAutopilotPost({
    accountId: account.id,
    text: result.text,
    link: result.product.url,
    imageUrl: media.imageUrl,
    extraImageUrl: media.extraImageUrl,
    recipeCommentText: result.commentLead,
  });

  const lastKeyword = result.productSearchTerm || result.secretTerm || result.topic;
  recordAutopilotLast(account.id, lastKeyword, target);
  console.log(`[자동발행 예약][V3 THREADS-FIRST] account #${account.id} target="${target}" mode="${result.mode}" topic="${result.topic}" product="${result.product.name}" search="${result.productSearchTerm}" source="${result.sourceUrl}" image="${media.imageSourceLabel}"`);
}

function startAutopilotJob() {
  const nextRunAt = new Map();
  cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (const summary of listAllAccountsForSystem()) {
      const account = getAccount(summary.id);
      if (!account.autopilot_enabled) { nextRunAt.delete(account.id); continue; }

      if (hasCoupangKeys(account)) {
        const cooldown = coupangApi.getApiCooldown?.(account.id);
        if (cooldown) {
          console.log(`[Coupang][AUTOPILOT SKIP] account=${account.id} cooldown_until=${cooldown.cooldown_until}`);
          continue;
        }
      }

      const due = nextRunAt.get(account.id) || 0;
      if (now < due) continue;
      nextRunAt.set(account.id, now + randomIntervalMinutes() * 60 * 1000);

      try {
        await runAutopilotOnce(account);
      } catch (err) {
        if (coupangApi.isRateLimitError?.(err)) {
          console.error(`[완전자동화 중단][Coupang rate limit] account #${account.id}: ${err.message}`);
          continue;
        }
        console.error(`[완전자동화 실패] account #${account.id}:`, err.response?.data || err.message);
      }
    }
  });
}

module.exports = { startPublishJob, startInsightsJob, startAutopilotJob };
