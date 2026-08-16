const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const {
  db,
  listAllAccountsForSystem,
  getAccount,
  canPublish,
  findMediaSourceForProduct,
  markMediaSourceUsed,
} = require('./db');

const {
  publishPost,
  publishCarouselPost,
  publishReply,
  getMediaInsights,
} = require('./threadsApi');

const coupangApi = require('./coupangApi');
const {
  generateCaption,
  suggestKeywordCandidates,
} = require('./aiCaption');
const {
  generateStoryCaption,
  generateAffiliateLead,
} = require('./aiSocial');
const { rankKeywordsByTrend } = require('./naverTrends');
const { findAutopilotYoutubeSource } = require('./youtubeSourcing');
const { buildRecipeAutopilot } = require('./recipeAutomation');

// 레시피형 댓글 원문을 예약 시점에 저장하기 위한 최소 마이그레이션.
// 기존 DB/신규 DB 모두 안전하게 동작하도록 scheduler 로드 시 한 번 보장한다.
try {
  db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`);
} catch {
  // 이미 있으면 무시
}

function buildDisclosureText(account, link) {
  const template = account.coupang_disclosure_template || '{link}';
  return template.replace('{link}', link);
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

  // 레시피형은 예약 생성 단계에서 상세 레시피 댓글을 완성해 저장한다.
  if (post.recipe_comment_text) {
    return `${post.recipe_comment_text}\n\n${disclosure}`;
  }

  try {
    const lead = await generateAffiliateLead(account.id, { postText: post.text });
    if (lead) return `${lead}\n\n${disclosure}`;
  } catch (err) {
    console.error(
      `[댓글 연결문구 생성 실패, 고지문만 사용] account #${account.id} post #${post.id}:`,
      err.message
    );
  }

  return disclosure;
}

async function postAffiliateComment(account, post, parentMediaId) {
  if (!post.link || !post.auto_comment_enabled) return;

  try {
    const commentText = await buildCommentText(account, post);
    const commentMediaId = await publishReply(account.id, parentMediaId, commentText);

    db.prepare(
      `UPDATE posts
       SET comment_status = 'posted', comment_media_id = ?, comment_posted_at = ?
       WHERE id = ?`
    ).run(commentMediaId, new Date().toISOString(), post.id);

    console.log(
      `[댓글 등록 완료] account #${account.id} post #${post.id} -> comment ${commentMediaId}`
    );
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    db.prepare(
      `UPDATE posts SET comment_status = 'failed', comment_error_message = ? WHERE id = ?`
    ).run(msg, post.id);
    console.error(`[댓글 등록 실패] account #${account.id} post #${post.id}:`, msg);
  }
}

function startPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const accounts = listAllAccountsForSystem();

    for (const accountSummary of accounts) {
      const account = getAccount(accountSummary.id);
      const duePosts = db
        .prepare(
          `SELECT * FROM posts
           WHERE account_id = ? AND status = 'pending' AND scheduled_at <= ?
           ORDER BY scheduled_at ASC`
        )
        .all(account.id, now);

      for (const post of duePosts) {
        if (account.user_id && !canPublish(account.user_id)) {
          db.prepare(
            `UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`
          ).run('오늘 발행 가능 횟수를 다 썼습니다 (요금제 하루 한도 초과)', post.id);
          console.log(
            `[발행 차단] account #${account.id} post #${post.id}: 하루 발행 한도 초과`
          );
          continue;
        }

        try {
          let mediaId;

          if (post.image_url && post.extra_image_url) {
            mediaId = await publishCarouselPost(account.id, {
              text: post.text,
              imageUrls: [post.image_url, post.extra_image_url],
            });
          } else {
            mediaId = await publishPost(account.id, {
              text: post.text,
              imageUrl: post.image_url,
              videoUrl: post.video_url,
            });
          }

          db.prepare(
            `UPDATE posts SET status = 'posted', threads_media_id = ?, posted_at = ? WHERE id = ?`
          ).run(mediaId, new Date().toISOString(), post.id);

          db.prepare(
            `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes)
             VALUES (?, 0, 0, 0, 0, 0)
             ON CONFLICT(post_id) DO NOTHING`
          ).run(post.id);

          console.log(
            `[발행 완료] account #${account.id} post #${post.id} -> media ${mediaId}`
          );

          await new Promise((resolve) => setTimeout(resolve, 3000));
          await postAffiliateComment(account, post, mediaId);
        } catch (err) {
          const apiErr = err.response?.data?.error;
          const msg = apiErr
            ? `${apiErr.message} (type: ${apiErr.type || '-'}, code: ${apiErr.code || '-'}${
                apiErr.error_subcode ? ', subcode: ' + apiErr.error_subcode : ''
              })`
            : err.message;

          db.prepare(
            `UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`
          ).run(msg, post.id);

          console.error(`[발행 실패] account #${account.id} post #${post.id}:`, msg);
          console.error(
            `[발행 실패 상세] account #${account.id} post #${post.id} userId=${account.threads_user_id} status=${err.response?.status} rawBody=`,
            JSON.stringify(err.response?.data || {})
          );
        }
      }
    }
  });
}

function startInsightsJob() {
  cron.schedule('*/10 * * * *', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const accounts = listAllAccountsForSystem();

    for (const accountSummary of accounts) {
      const postedToday = db
        .prepare(
          `SELECT * FROM posts
           WHERE account_id = ? AND status = 'posted' AND posted_at >= ?
             AND threads_media_id IS NOT NULL`
        )
        .all(accountSummary.id, startOfDay.toISOString());

      for (const post of postedToday) {
        try {
          const stats = await getMediaInsights(accountSummary.id, post.threads_media_id);
          db.prepare(
            `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(post_id) DO UPDATE SET
               views = excluded.views,
               likes = excluded.likes,
               replies = excluded.replies,
               reposts = excluded.reposts,
               quotes = excluded.quotes,
               updated_at = excluded.updated_at`
          ).run(
            post.id,
            stats.views || 0,
            stats.likes || 0,
            stats.replies || 0,
            stats.reposts || 0,
            stats.quotes || 0,
            new Date().toISOString()
          );
        } catch (err) {
          console.error(
            `[인사이트 갱신 실패] account #${accountSummary.id} post #${post.id}:`,
            err.response?.data || err.message
          );
        }
      }
    }
  });
}

function randomIntervalMinutes() {
  return 60 + Math.random() * 15;
}

const AUTOPILOT_TARGETS = [
  '전체',
  '20대 여자',
  '20대 남자',
  '30대 여자',
  '30대 남자',
  '40대 이상',
];

// 수익화 우선 비율:
// recipe 60% / story 25% / product 15%
function chooseContentMode() {
  const r = Math.random();
  if (r < 0.6) return 'recipe';
  if (r < 0.85) return 'story';
  return 'product';
}

function saveAutopilotPost({
  accountId,
  text,
  link,
  imageUrl,
  extraImageUrl,
  recipeCommentText = null,
}) {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO posts (
      text,
      link,
      image_url,
      extra_image_url,
      scheduled_at,
      auto_comment_enabled,
      comment_status,
      account_id,
      recipe_comment_text
    ) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)`
  ).run(
    text,
    link,
    imageUrl,
    extraImageUrl,
    now,
    accountId,
    recipeCommentText
  );
}

function recordAutopilotLast(accountId, keyword, target) {
  db.prepare(
    `UPDATE accounts
     SET autopilot_last_keyword = ?, autopilot_last_target = ?
     WHERE id = ?`
  ).run(keyword, target, accountId);
}

async function pickRegularProduct(account, target) {
  let picked;
  let keyword;
  let trendNote;

  try {
    const goldbox = await coupangApi.getGoldboxProducts(account.id, 30);
    if (!goldbox.length) throw new Error('골드박스 상품 목록이 비어있습니다');

    const pool = goldbox.slice(0, Math.min(15, goldbox.length));
    picked = pool[Math.floor(Math.random() * pool.length)];
    keyword = picked.name;
    trendNote = `쿠팡 골드박스 특가${
      picked.discountRate ? ` (${picked.discountRate}% 할인)` : ''
    }`;
  } catch (goldboxErr) {
    console.error(
      `[골드박스 조회 실패, 카테고리 베스트 랭킹으로 폴백] account #${account.id}:`,
      goldboxErr.response?.data || goldboxErr.message
    );

    try {
      const categoryNames = Object.keys(coupangApi.BEST_CATEGORY_IDS);
      const categoryName = categoryNames[Math.floor(Math.random() * categoryNames.length)];
      const categoryId = coupangApi.BEST_CATEGORY_IDS[categoryName];
      const bestList = await coupangApi.getBestCategoryProducts(account.id, categoryId, 20);
      if (!bestList.length) {
        throw new Error(`"${categoryName}" 베스트 상품 목록이 비어있습니다`);
      }

      const bestPool = bestList.slice(0, Math.min(10, bestList.length));
      picked = bestPool[Math.floor(Math.random() * bestPool.length)];
      keyword = categoryName;
      trendNote = `쿠팡 베스트카테고리 랭킹${
        picked.rank ? ` (${picked.rank}위)` : ''
      }`;
    } catch (bestErr) {
      console.error(
        `[베스트카테고리 조회도 실패, AI 키워드 검색으로 폴백] account #${account.id}:`,
        bestErr.response?.data || bestErr.message
      );

      const candidates = await suggestKeywordCandidates(account.id, target);
      keyword = candidates[0];
      trendNote = '트렌드 비교 없이 AI 1순위 선택';

      try {
        const ranked = await rankKeywordsByTrend(account.id, candidates);
        if (ranked && ranked.length) {
          keyword = ranked[0].keyword;
          trendNote = `네이버 데이터랩 트렌드 1위 (평균 지수 ${ranked[0].avgRatio.toFixed(1)})`;
        }
      } catch (err) {
        console.error(
          `[트렌드 비교 실패] account #${account.id}:`,
          err.response?.data || err.message
        );
      }

      const products = await coupangApi.searchProducts(account.id, keyword, 8);
      if (!products.length) throw new Error(`"${keyword}" 검색 결과가 없습니다`);
      const pool = products.slice(0, Math.min(5, products.length));
      picked = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  return { picked, keyword, trendNote };
}

async function runAutopilotOnce(account) {
  const target =
    AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];

  let contentMode = chooseContentMode();

  // ==================================================
  // 60% 레시피형
  // 레시피 주제 → 관련 짧은 YouTube 영상 → 상세 레시피 생성
  // → 비밀 소스 키워드 → 쿠팡 검색 → 상세 레시피 댓글 + 쿠파스 링크
  // ==================================================
  if (contentMode === 'recipe') {
    try {
      const recipeResult = await buildRecipeAutopilot({ account, target });

      saveAutopilotPost({
        accountId: account.id,
        text: recipeResult.text,
        link: recipeResult.link,
        imageUrl: recipeResult.imageUrl,
        extraImageUrl: recipeResult.extraImageUrl,
        recipeCommentText: recipeResult.recipeCommentText,
      });

      recordAutopilotLast(account.id, recipeResult.keyword, target);

      console.log(
        `[자동발행 예약] account #${account.id} mode="recipe" target="${target}" keyword="${recipeResult.keyword}" (${recipeResult.trendNote}) product="${recipeResult.product.name}" image="${recipeResult.imageSourceLabel}"`
      );
      return;
    } catch (err) {
      // 레시피형 실패가 전체 자동화를 막지 않도록 일반 상품형으로 폴백.
      console.log(
        `[Recipe] 레시피형 생성 실패 — 일반 상품형으로 폴백: ${err.response?.data?.error?.message || err.message}`
      );
      contentMode = 'product';
    }
  }

  const { picked, keyword, trendNote } = await pickRegularProduct(account, target);

  let text;
  let imageUrl = null;
  let extraImageUrl = null;
  let imageSourceLabel = '없음';

  if (contentMode === 'story') {
    text = await generateStoryCaption(account.id, {
      productName: picked.name,
      price: picked.price,
      target,
    });

    imageUrl = null;
    extraImageUrl = null;
    imageSourceLabel = '없음';
  } else {
    let youtubeSource = null;

    if (
      account.autopilot_youtube_source_enabled === undefined ||
      account.autopilot_youtube_source_enabled === null ||
      account.autopilot_youtube_source_enabled
    ) {
      youtubeSource = await findAutopilotYoutubeSource({
        accountId: account.id,
        productName: picked.name,
        order: account.autopilot_youtube_order || 'relevance',
      });
    }

    const texts = await generateCaption(account.id, {
      productName: picked.name,
      price: picked.price,
      target,
      youtubeSource,
    });

    text = texts[Math.floor(Math.random() * texts.length)];

    imageUrl = picked.image || null;
    extraImageUrl = null;
    imageSourceLabel = imageUrl ? '원본 상품컷 1장' : '없음';

    if (youtubeSource?.thumbnail) {
      imageUrl = youtubeSource.thumbnail;
      extraImageUrl = picked.image || null;
      imageSourceLabel = extraImageUrl
        ? 'YouTube 썸네일 + 상품컷'
        : 'YouTube 썸네일 1장';

      console.log(
        `[Media] YouTube 썸네일 사용 — "${youtubeSource.title}"${
          extraImageUrl ? ' + 상품 이미지' : ''
        }`
      );
    }

    if (account.autopilot_frame_media_enabled) {
      try {
        const media = findMediaSourceForProduct(account.id, picked.name);
        if (media && media.image_url) {
          if (mediaSourceFilesExist(media)) {
            console.log(
              `[Media] 연결된 영상 프레임 확인 — "${picked.name}" ↔ "${media.product_keyword}"`
            );
            imageUrl = media.image_url;
            extraImageUrl = media.extra_image_url || null;
            imageSourceLabel = extraImageUrl
              ? '업로드 프레임 2장'
              : '업로드 프레임 1장';
            markMediaSourceUsed(media.id);
          } else {
            console.log(
              '[Media] 저장된 프레임 파일을 찾을 수 없음(재배포로 소실 추정) — YouTube/상품 이미지 fallback 유지'
            );
          }
        }
      } catch (err) {
        console.log(
          '[Media] 프레임 매칭 중 오류 — YouTube/상품 이미지 fallback 유지:',
          err.message
        );
      }
    }
  }

  saveAutopilotPost({
    accountId: account.id,
    text,
    link: picked.url,
    imageUrl,
    extraImageUrl,
  });

  recordAutopilotLast(account.id, keyword, target);

  console.log(
    `[자동발행 예약] account #${account.id} mode="${contentMode}" target="${target}" keyword="${keyword}" (${trendNote}) product="${picked.name}" image="${imageSourceLabel}"`
  );
}

function startAutopilotJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();

    const dueAccounts = db
      .prepare(
        `SELECT * FROM accounts
         WHERE autopilot_enabled = 1
           AND (autopilot_next_at IS NULL OR autopilot_next_at <= ?)`
      )
      .all(now);

    for (const account of dueAccounts) {
      const nextAt = new Date(
        Date.now() + randomIntervalMinutes() * 60000
      ).toISOString();

      db.prepare(`UPDATE accounts SET autopilot_next_at = ? WHERE id = ?`).run(
        nextAt,
        account.id
      );

      try {
        await runAutopilotOnce(account);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error(`[자동발행 실패] account #${account.id}:`, msg);
      }
    }
  });
}

module.exports = {
  startPublishJob,
  startInsightsJob,
  startAutopilotJob,
};