const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { db, listAllAccountsForSystem, getAccount, canPublish, findMediaSourceForProduct, markMediaSourceUsed } = require('./db');
const { publishPost, publishCarouselPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateCaption, suggestKeywordCandidates } = require('./aiCaption');
const { generateAffiliateLead } = require('./aiSocial');
const { rankKeywordsByTrend } = require('./naverTrends');
const { findAutopilotYoutubeSource } = require('./youtubeSourcing');
const { buildRecipeAutopilot } = require('./recipeAutomation');
const { generateRecipe: generateContentOnlyRecipe } = require('./contentOnlyAutomation');

try { db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`); } catch {}

function hasCoupangKeys(account) {
  return !!(String(account?.coupang_access_key || '').trim() && String(account?.coupang_secret_key || '').trim());
}

function isCoupangLink(link) {
  return /(^|\.)coupang\.com|link\.coupang\.com/i.test(String(link || ''));
}

function buildDisclosureText(account, link) {
  if (!link) return '';
  if (isCoupangLink(link)) return (account.coupang_disclosure_template || '{link}').replace('{link}', link);
  // 네이버 쇼핑 커넥트 등 수동 제휴 링크는 쿠팡 고지문을 잘못 붙이지 않는다.
  // 프로그램별 대가성 표시는 사용자가 본문/댓글에 직접 입력한다.
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
  // 레시피 댓글은 제휴 링크가 없어도 재료/조리법 전달을 위해 게시한다.
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
// 자동화는 레시피 또는 상품형만 사용한다. 일상/잡담형은 생성하지 않는다.
function chooseContentMode() { return Math.random() < 0.70 ? 'recipe' : 'product'; }
function saveAutopilotPost({ accountId, text, link, imageUrl, extraImageUrl, recipeCommentText = null }) {
  db.prepare(`INSERT INTO posts (text,link,image_url,extra_image_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text) VALUES (?,?,?,?,?,1,'pending',?,?)`).run(text, link || null, imageUrl || null, extraImageUrl || null, new Date().toISOString(), accountId, recipeCommentText);
}
function recordAutopilotLast(accountId, keyword, target) { db.prepare(`UPDATE accounts SET autopilot_last_keyword=?, autopilot_last_target=? WHERE id=?`).run(keyword, target, accountId); }
function throwIfCoupangRateLimited(err) { if (coupangApi.isRateLimitError?.(err)) throw err; }

async function runContentOnlyAutopilot(account, target) {
  // 쿠팡 API 키가 없어도 일상글로 빠지지 않고 레시피만 만든다.
  const r = await generateContentOnlyRecipe(account.id, target);
  saveAutopilotPost({ accountId: account.id, text: r.text, link: null, imageUrl: r.imageUrl, extraImageUrl: r.extraImageUrl, recipeCommentText: r.recipeCommentText });
  recordAutopilotLast(account.id, r.keyword, target);
  console.log(`[자동발행 예약] account #${account.id} mode="recipe-no-commerce" target="${target}" keyword="${r.keyword}" (${r.trendNote}) image="${r.imageSourceLabel}"`);
}

async function pickRegularProduct(account, target) {
  let picked, keyword, trendNote;
  try {
    const goldbox = await coupangApi.getGoldboxProducts(account.id, 30);
    if (!goldbox.length) throw new Error('골드박스 상품 목록이 비어있습니다');
    const pool = goldbox.slice(0, Math.min(15, goldbox.length));
    picked = pool[Math.floor(Math.random() * pool.length)];
    keyword = picked.name;
    trendNote = `쿠팡 골드박스 특가${picked.discountRate ? ` (${picked.discountRate}% 할인)` : ''}`;
  } catch (goldboxErr) {
    throwIfCoupangRateLimited(goldboxErr);
    console.error(`[골드박스 조회 실패, 카테고리 베스트 랭킹으로 폴백] account #${account.id}:`, goldboxErr.response?.data || goldboxErr.message);
    try {
      const categoryNames = Object.keys(coupangApi.BEST_CATEGORY_IDS);
      const categoryName = categoryNames[Math.floor(Math.random() * categoryNames.length)];
      const categoryId = coupangApi.BEST_CATEGORY_IDS[categoryName];
      const bestList = await coupangApi.getBestCategoryProducts(account.id, categoryId, 20);
      if (!bestList.length) throw new Error(`"${categoryName}" 베스트 상품 목록이 비어있습니다`);
      const bestPool = bestList.slice(0, Math.min(10, bestList.length));
      picked = bestPool[Math.floor(Math.random() * bestPool.length)];
      keyword = categoryName;
      trendNote = `쿠팡 베스트카테고리 랭킹${picked.rank ? ` (${picked.rank}위)` : ''}`;
    } catch (bestErr) {
      throwIfCoupangRateLimited(bestErr);
      console.error(`[베스트카테고리 조회도 실패, AI 키워드 검색으로 폴백] account #${account.id}:`, bestErr.response?.data || bestErr.message);
      const candidates = await suggestKeywordCandidates(account.id, target);
      keyword = candidates[0];
      trendNote = '트렌드 비교 없이 AI 1순위 선택';
      try {
        const ranked = await rankKeywordsByTrend(account.id, candidates);
        if (ranked && ranked.length) { keyword = ranked[0].keyword; trendNote = `네이버 데이터랩 트렌드 1위 (평균 지수 ${ranked[0].avgRatio.toFixed(1)})`; }
      } catch (err) { console.error(`[트렌드 비교 실패] account #${account.id}:`, err.response?.data || err.message); }
      const products = await coupangApi.searchProducts(account.id, keyword, 8);
      if (!products.length) throw new Error(`"${keyword}" 검색 결과가 없습니다`);
      const pool = products.slice(0, Math.min(5, products.length));
      picked = pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return { picked, keyword, trendNote };
}

async function runAutopilotOnce(account) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];

  // 쿠팡 API 키가 없는 계정은 상품 API를 호출하지 않고 레시피 자동화만 실행한다.
  if (!hasCoupangKeys(account)) {
    console.log(`[Autopilot][RECIPE ONLY] account=${account.id} 쿠팡 API 키 없음 → 레시피 모드`);
    await runContentOnlyAutopilot(account, target);
    return;
  }

  let contentMode = chooseContentMode();
  const cooldown = coupangApi.getApiCooldown?.(account.id);
  if (cooldown) {
    const err = new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`);
    err.code = 'COUPANG_RATE_LIMIT'; err.isCoupangRateLimit = true; throw err;
  }

  if (contentMode === 'recipe') {
    try {
      const recipeResult = await buildRecipeAutopilot({ account, target });
      saveAutopilotPost({ accountId: account.id, text: recipeResult.text, link: recipeResult.link, imageUrl: recipeResult.imageUrl, extraImageUrl: recipeResult.extraImageUrl, recipeCommentText: recipeResult.recipeCommentText });
      recordAutopilotLast(account.id, recipeResult.keyword, target);
      console.log(`[자동발행 예약] account #${account.id} mode="recipe" target="${target}" keyword="${recipeResult.keyword}" (${recipeResult.trendNote}) product="${recipeResult.product.name}" image="${recipeResult.imageSourceLabel}"`);
      return;
    } catch (err) {
      throwIfCoupangRateLimited(err);
      console.log(`[Recipe] 레시피형 생성 실패 — 일반 상품형으로 폴백: ${err.response?.data?.error?.message || err.message}`);
      contentMode = 'product';
    }
  }

  const { picked, keyword, trendNote } = await pickRegularProduct(account, target);
  let youtubeSource = null;
  if (account.autopilot_youtube_source_enabled) youtubeSource = await findAutopilotYoutubeSource({ accountId: account.id, productName: picked.name, order: account.autopilot_youtube_order || 'relevance' });
  const variants = await generateCaption(account.id, { productName: picked.name, price: picked.price, youtubeSource });
  const text = Array.isArray(variants) ? variants[Math.floor(Math.random() * variants.length)] : String(variants || '');
  let imageUrl = picked.image || null;
  let extraImageUrl = null;
  let imageSourceLabel = picked.image ? '원본 상품컷 1장' : '없음';
  if (account.autopilot_frame_media_enabled) {
    try {
      const media = findMediaSourceForProduct(account.id, picked.name);
      if (media && mediaSourceFilesExist(media)) {
        imageUrl = media.image_url; extraImageUrl = media.extra_image_url || null; markMediaSourceUsed(media.id);
        imageSourceLabel = extraImageUrl ? '저장 프레임 2장' : '저장 프레임 1장';
      }
    } catch (err) { console.log(`[Media] 저장 프레임 조회 실패 — 상품 이미지 유지: ${err.message}`); }
  }
  saveAutopilotPost({ accountId: account.id, text, link: picked.url, imageUrl, extraImageUrl });
  recordAutopilotLast(account.id, keyword, target);
  console.log(`[자동발행 예약] account #${account.id} mode="product" target="${target}" keyword="${keyword}" (${trendNote}) product="${picked.name}" image="${imageSourceLabel}"`);
}

function startAutopilotJob() {
  const nextRunAt = new Map();
  cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (const summary of listAllAccountsForSystem()) {
      const account = getAccount(summary.id);
      if (!account.autopilot_enabled) { nextRunAt.delete(account.id); continue; }

      // 쿠팡 키가 없는 계정은 쿠팡 cooldown과 무관하게 레시피 자동화를 계속 실행한다.
      if (hasCoupangKeys(account)) {
        const cooldown = coupangApi.getApiCooldown?.(account.id);
        if (cooldown) { console.log(`[Coupang][AUTOPILOT SKIP] account=${account.id} cooldown_until=${cooldown.cooldown_until}`); continue; }
      }

      const due = nextRunAt.get(account.id) || 0;
      if (now < due) continue;
      nextRunAt.set(account.id, now + randomIntervalMinutes() * 60 * 1000);
      try {
        await runAutopilotOnce(account);
      } catch (err) {
        if (coupangApi.isRateLimitError?.(err)) { console.error(`[완전자동화 중단][Coupang rate limit] account #${account.id}: ${err.message}`); continue; }
        console.error(`[완전자동화 실패] account #${account.id}:`, err.response?.data || err.message);
      }
    }
  });
}

module.exports = { startPublishJob, startInsightsJob, startAutopilotJob };
