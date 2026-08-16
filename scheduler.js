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


// ====================================================
// 쿠팡파트너스 고지문 + 링크
// ====================================================

function buildDisclosureText(account, link) {
  const template =
    account.coupang_disclosure_template || '{link}';

  return template.replace('{link}', link);
}

// media_sources에 저장된 image_url/extra_image_url이 실제로 아직 디스크에 남아있는지 확인.
// URL은 "<baseUrl>/uploads/frames/<accountId>/<jobId>/frame_NN.jpg" 형태이므로, "/uploads/" 뒤
// 경로만 떼어내 uploadsDir 기준으로 실존 여부를 확인한다. Railway처럼 재배포로 로컬 파일이
// 사라질 수 있는 환경에서, DB 레코드만 남고 실제 파일은 없는 상태를 걸러내기 위함이다.
const uploadsDir = path.join(__dirname, 'uploads');
function localPathFromUploadUrl(url) {
  if (!url) return null;
  const marker = '/uploads/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const relPath = url.slice(idx + marker.length);
  return path.join(uploadsDir, relPath);
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


// ====================================================
// 본문에 맞는 자연스러운 첫 댓글 생성
// ====================================================

async function buildCommentText(account, post) {
  const disclosure = buildDisclosureText(
    account,
    post.link
  );

  try {
    const lead = await generateAffiliateLead(
      account.id,
      {
        postText: post.text,
      }
    );

    if (lead) {
      return `${lead}\n\n${disclosure}`;
    }
  } catch (err) {
    console.error(
      `[댓글 연결문구 생성 실패, 고지문만 사용] account #${account.id} post #${post.id}:`,
      err.message
    );
  }

  return disclosure;
}


// ====================================================
// 쿠팡파트너스 첫 댓글 게시
// ====================================================

async function postAffiliateComment(
  account,
  post,
  parentMediaId
) {
  if (!post.link || !post.auto_comment_enabled) {
    return;
  }

  try {
    const commentText =
      await buildCommentText(account, post);

    const commentMediaId =
      await publishReply(
        account.id,
        parentMediaId,
        commentText
      );

    db.prepare(
      `
      UPDATE posts
      SET
        comment_status = 'posted',
        comment_media_id = ?,
        comment_posted_at = ?
      WHERE id = ?
      `
    ).run(
      commentMediaId,
      new Date().toISOString(),
      post.id
    );

    console.log(
      `[댓글 등록 완료] account #${account.id} post #${post.id} -> comment ${commentMediaId}`
    );
  } catch (err) {
    const msg =
      err.response?.data?.error?.message ||
      err.message;

    db.prepare(
      `
      UPDATE posts
      SET
        comment_status = 'failed',
        comment_error_message = ?
      WHERE id = ?
      `
    ).run(
      msg,
      post.id
    );

    console.error(
      `[댓글 등록 실패] account #${account.id} post #${post.id}:`,
      msg
    );
  }
}


// ====================================================
// 예약글 발행
// ====================================================

function startPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();

    const accounts =
      listAllAccountsForSystem();

    for (const accountSummary of accounts) {
      const account =
        getAccount(accountSummary.id);

      const duePosts = db
        .prepare(
          `
          SELECT *
          FROM posts
          WHERE account_id = ?
            AND status = 'pending'
            AND scheduled_at <= ?
          ORDER BY scheduled_at ASC
          `
        )
        .all(
          account.id,
          now
        );

      for (const post of duePosts) {

        // --------------------------------------------
        // 요금제 발행 한도 체크
        // --------------------------------------------

        if (
          account.user_id &&
          !canPublish(account.user_id)
        ) {
          db.prepare(
            `
            UPDATE posts
            SET
              status = 'failed',
              error_message = ?
            WHERE id = ?
            `
          ).run(
            '오늘 발행 가능 횟수를 다 썼습니다 (요금제 하루 한도 초과)',
            post.id
          );

          console.log(
            `[발행 차단] account #${account.id} post #${post.id}: 하루 발행 한도 초과`
          );

          continue;
        }

        try {

          // ------------------------------------------
          // 기존 게시물 호환
          // ------------------------------------------

          let mediaId;

          if (
            post.image_url &&
            post.extra_image_url
          ) {
            mediaId =
              await publishCarouselPost(
                account.id,
                {
                  text: post.text,
                  imageUrls: [
                    post.image_url,
                    post.extra_image_url,
                  ],
                }
              );
          } else {
            mediaId =
              await publishPost(
                account.id,
                {
                  text: post.text,
                  imageUrl:
                    post.image_url,
                  videoUrl:
                    post.video_url,
                }
              );
          }

          db.prepare(
            `
            UPDATE posts
            SET
              status = 'posted',
              threads_media_id = ?,
              posted_at = ?
            WHERE id = ?
            `
          ).run(
            mediaId,
            new Date().toISOString(),
            post.id
          );

          db.prepare(
            `
            INSERT INTO insights (
              post_id,
              views,
              likes,
              replies,
              reposts,
              quotes
            )
            VALUES (?, 0, 0, 0, 0, 0)

            ON CONFLICT(post_id)
            DO NOTHING
            `
          ).run(post.id);

          console.log(
            `[발행 완료] account #${account.id} post #${post.id} -> media ${mediaId}`
          );

          await new Promise(
            (resolve) =>
              setTimeout(resolve, 3000)
          );

          await postAffiliateComment(
            account,
            post,
            mediaId
          );

        } catch (err) {

          const apiErr =
            err.response?.data?.error;

          const msg = apiErr
            ? `${apiErr.message} (type: ${
                apiErr.type || '-'
              }, code: ${
                apiErr.code || '-'
              }${
                apiErr.error_subcode
                  ? ', subcode: ' +
                    apiErr.error_subcode
                  : ''
              })`
            : err.message;

          db.prepare(
            `
            UPDATE posts
            SET
              status = 'failed',
              error_message = ?
            WHERE id = ?
            `
          ).run(
            msg,
            post.id
          );

          console.error(
            `[발행 실패] account #${account.id} post #${post.id}:`,
            msg
          );

          console.error(
            `[발행 실패 상세] account #${account.id} post #${post.id} userId=${account.threads_user_id} status=${err.response?.status} rawBody=`,
            JSON.stringify(
              err.response?.data || {}
            )
          );
        }
      }
    }
  });
}


// ====================================================
// Threads 인사이트 갱신
// ====================================================

function startInsightsJob() {
  cron.schedule(
    '*/10 * * * *',
    async () => {

      const startOfDay =
        new Date();

      startOfDay.setHours(
        0,
        0,
        0,
        0
      );

      const accounts =
        listAllAccountsForSystem();

      for (
        const accountSummary
        of accounts
      ) {

        const postedToday = db
          .prepare(
            `
            SELECT *
            FROM posts
            WHERE account_id = ?
              AND status = 'posted'
              AND posted_at >= ?
              AND threads_media_id IS NOT NULL
            `
          )
          .all(
            accountSummary.id,
            startOfDay.toISOString()
          );

        for (
          const post
          of postedToday
        ) {
          try {

            const stats =
              await getMediaInsights(
                accountSummary.id,
                post.threads_media_id
              );

            db.prepare(
              `
              INSERT INTO insights (
                post_id,
                views,
                likes,
                replies,
                reposts,
                quotes,
                updated_at
              )

              VALUES (?, ?, ?, ?, ?, ?, ?)

              ON CONFLICT(post_id)
              DO UPDATE SET

                views =
                  excluded.views,

                likes =
                  excluded.likes,

                replies =
                  excluded.replies,

                reposts =
                  excluded.reposts,

                quotes =
                  excluded.quotes,

                updated_at =
                  excluded.updated_at
              `
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
              err.response?.data ||
                err.message
            );
          }
        }
      }
    }
  );
}


// ====================================================
// 오토파일럿 랜덤 발행 간격
// 60~75분
// ====================================================

function randomIntervalMinutes() {
  return (
    60 +
    Math.random() * 15
  );
}


// ====================================================
// 타겟
// ====================================================

const AUTOPILOT_TARGETS = [
  '전체',
  '20대 여자',
  '20대 남자',
  '30대 여자',
  '30대 남자',
  '40대 이상',
];


// ====================================================
// 콘텐츠 유형 결정
//
// 약 65% = 일반 상품형
// 약 35% = 썰형 상품글
// ====================================================

function chooseContentMode() {
  return Math.random() < 0.35
    ? 'story'
    : 'product';
}


// ====================================================
// 오토파일럿 1회 실행
// ====================================================

async function runAutopilotOnce(
  account
) {

  const target =
    AUTOPILOT_TARGETS[
      Math.floor(
        Math.random() *
          AUTOPILOT_TARGETS.length
      )
    ];

  let picked;
  let keyword;
  let trendNote;


  // ==================================================
  // 1순위
  // 쿠팡 골드박스
  // ==================================================

  try {

    const goldbox =
      await coupangApi.getGoldboxProducts(
        account.id,
        30
      );

    if (!goldbox.length) {
      throw new Error(
        '골드박스 상품 목록이 비어있습니다'
      );
    }

    const pool =
      goldbox.slice(
        0,
        Math.min(
          15,
          goldbox.length
        )
      );

    picked =
      pool[
        Math.floor(
          Math.random() *
            pool.length
        )
      ];

    keyword =
      picked.name;

    trendNote =
      `쿠팡 골드박스 특가${
        picked.discountRate
          ? ` (${picked.discountRate}% 할인)`
          : ''
      }`;

  } catch (goldboxErr) {

    console.error(
      `[골드박스 조회 실패, 카테고리 베스트 랭킹으로 폴백] account #${account.id}:`,
      goldboxErr.response?.data ||
        goldboxErr.message
    );


    // ================================================
    // 2순위
    // 쿠팡 카테고리 베스트
    // ================================================

    try {

      const categoryNames =
        Object.keys(
          coupangApi.BEST_CATEGORY_IDS
        );

      const categoryName =
        categoryNames[
          Math.floor(
            Math.random() *
              categoryNames.length
          )
        ];

      const categoryId =
        coupangApi
          .BEST_CATEGORY_IDS[
            categoryName
          ];

      const bestList =
        await coupangApi
          .getBestCategoryProducts(
            account.id,
            categoryId,
            20
          );

      if (!bestList.length) {
        throw new Error(
          `"${categoryName}" 베스트 상품 목록이 비어있습니다`
        );
      }

      const bestPool =
        bestList.slice(
          0,
          Math.min(
            10,
            bestList.length
          )
        );

      picked =
        bestPool[
          Math.floor(
            Math.random() *
              bestPool.length
          )
        ];

      keyword =
        categoryName;

      trendNote =
        `쿠팡 베스트카테고리 랭킹${
          picked.rank
            ? ` (${picked.rank}위)`
            : ''
        }`;

    } catch (bestErr) {

      console.error(
        `[베스트카테고리 조회도 실패, AI 키워드 검색으로 폴백] account #${account.id}:`,
        bestErr.response?.data ||
          bestErr.message
      );


      // ==============================================
      // 3순위
      // AI 키워드 + 네이버 데이터랩
      // ==============================================

      const candidates =
        await suggestKeywordCandidates(
          account.id,
          target
        );

      keyword =
        candidates[0];

      trendNote =
        '트렌드 비교 없이 AI 1순위 선택';


      try {

        const ranked =
          await rankKeywordsByTrend(
            account.id,
            candidates
          );

        if (
          ranked &&
          ranked.length
        ) {

          keyword =
            ranked[0].keyword;

          trendNote =
            `네이버 데이터랩 트렌드 1위 (평균 지수 ${ranked[0].avgRatio.toFixed(
              1
            )})`;
        }

      } catch (err) {

        console.error(
          `[트렌드 비교 실패] account #${account.id}:`,
          err.response?.data ||
            err.message
        );
      }


      // ==============================================
      // 쿠팡 검색
      // ==============================================

      const products =
        await coupangApi
          .searchProducts(
            account.id,
            keyword,
            8
          );

      if (!products.length) {
        throw new Error(
          `"${keyword}" 검색 결과가 없습니다`
        );
      }

      const pool =
        products.slice(
          0,
          Math.min(
            5,
            products.length
          )
        );

      picked =
        pool[
          Math.floor(
            Math.random() *
              pool.length
          )
        ];
    }
  }


  // ==================================================
  // 콘텐츠 유형 선택
  // ==================================================

  const contentMode =
    chooseContentMode();

  let text;

  let imageUrl = null;

  let extraImageUrl = null;

  let imageSourceLabel = '없음';


  // ==================================================
  // 썰형 상품글
  // 상품은 쿠팡 베스트/골드박스에서 먼저 선택.
  // 본문에서는 상품을 노골적으로 공개하지 않음.
  // 이미지 없음.
  // 댓글에서 상품 자연스럽게 연결.
  // ==================================================

  if (
    contentMode === 'story'
  ) {

    text =
      await generateStoryCaption(
        account.id,
        {
          productName:
            picked.name,

          price:
            picked.price,

          target,
        }
      );

    imageUrl = null;
    extraImageUrl = null;
    imageSourceLabel = '없음';


  // ==================================================
  // 일반 상품글
  // YouTube 소싱이 성공하면 쇼츠 썸네일 + 쿠팡 상품 이미지.
  // 저장된 직접 업로드 프레임이 있으면 그 프레임이 최우선.
  // ==================================================

  } else {

    let youtubeSource =
      null;

    if (
      account.autopilot_youtube_source_enabled === undefined ||
      account.autopilot_youtube_source_enabled === null ||
      account.autopilot_youtube_source_enabled
    ) {

      youtubeSource =
        await findAutopilotYoutubeSource({
          accountId: account.id,
          productName: picked.name,
          order: account.autopilot_youtube_order || 'relevance',
        });
    }

    const texts =
      await generateCaption(
        account.id,
        {
          productName:
            picked.name,

          price:
            picked.price,

          target,

          youtubeSource,
        }
      );

    text =
      texts[
        Math.floor(
          Math.random() *
            texts.length
        )
      ];

    // 기본 fallback은 기존 쿠팡 상품 이미지.
    imageUrl = picked.image || null;
    extraImageUrl = null;
    imageSourceLabel = imageUrl
      ? '원본 상품컷 1장'
      : '없음';

    // 관련 YouTube 콘텐츠의 공식 썸네일이 있으면 첫 장으로 사용하고,
    // 쿠팡 상품 이미지는 두 번째 장으로 배치한다.
    if (youtubeSource?.thumbnail) {
      imageUrl = youtubeSource.thumbnail;
      extraImageUrl = picked.image || null;
      imageSourceLabel = extraImageUrl
        ? 'YouTube 썸네일 + 상품컷'
        : 'YouTube 썸네일 1장';

      console.log(
        `[Media] YouTube 썸네일 사용 — "${youtubeSource.title}"${extraImageUrl ? ' + 상품 이미지' : ''}`
      );
    }

    // 사용자가 직접 업로드해 저장한 프레임이 있고 자동 프레임 사용 옵션이 켜져 있으면
    // YouTube 썸네일보다 우선한다.
    if (account.autopilot_frame_media_enabled) {
      try {
        const media = findMediaSourceForProduct(account.id, picked.name);
        if (media && media.image_url) {
          const filesExist = mediaSourceFilesExist(media);
          if (filesExist) {
            console.log(`[Media] 연결된 영상 프레임 확인 — "${picked.name}" ↔ "${media.product_keyword}"`);
            imageUrl = media.image_url;
            extraImageUrl = media.extra_image_url || null;
            imageSourceLabel = extraImageUrl
              ? '업로드 프레임 2장'
              : '업로드 프레임 1장';
            markMediaSourceUsed(media.id);
          } else {
            console.log('[Media] 저장된 프레임 파일을 찾을 수 없음(재배포로 소실 추정) — YouTube/상품 이미지 fallback 유지');
          }
        }
      } catch (err) {
        console.log('[Media] 프레임 매칭 중 오류 — YouTube/상품 이미지 fallback 유지:', err.message);
      }
    }
  }


  // ==================================================
  // 게시물 DB 저장
  // ==================================================

  const now =
    new Date().toISOString();

  db.prepare(
    `
    INSERT INTO posts (
      text,
      link,
      image_url,
      extra_image_url,
      scheduled_at,
      auto_comment_enabled,
      comment_status,
      account_id
    )

    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      1,
      'pending',
      ?
    )
    `
  ).run(
    text,
    picked.url,
    imageUrl,
    extraImageUrl,
    now,
    account.id
  );


  // ==================================================
  // 마지막 키워드 / 타겟 기록
  // ==================================================

  db.prepare(
    `
    UPDATE accounts
    SET
      autopilot_last_keyword = ?,
      autopilot_last_target = ?
    WHERE id = ?
    `
  ).run(
    keyword,
    target,
    account.id
  );


  console.log(
    `[자동발행 예약] account #${account.id} mode="${contentMode}" target="${target}" keyword="${keyword}" (${trendNote}) product="${picked.name}" image="${imageSourceLabel}"`
  );
}


// ====================================================
// 오토파일럿 체크
// ====================================================

function startAutopilotJob() {

  cron.schedule(
    '* * * * *',
    async () => {

      const now =
        new Date().toISOString();

      const dueAccounts =
        db.prepare(
          `
          SELECT *
          FROM accounts
          WHERE autopilot_enabled = 1
            AND (
              autopilot_next_at IS NULL
              OR autopilot_next_at <= ?
            )
          `
        ).all(now);


      for (
        const account
        of dueAccounts
      ) {

        const nextAt =
          new Date(
            Date.now() +
              randomIntervalMinutes() *
                60000
          ).toISOString();

        db.prepare(
          `
          UPDATE accounts
          SET autopilot_next_at = ?
          WHERE id = ?
          `
        ).run(
          nextAt,
          account.id
        );


        try {

          await runAutopilotOnce(
            account
          );

        } catch (err) {

          const msg =
            err.response?.data
              ?.error?.message ||
            err.message;

          console.error(
            `[자동발행 실패] account #${account.id}:`,
            msg
          );
        }
      }
    }
  );
}


// ====================================================
// EXPORT
// ====================================================

module.exports = {
  startPublishJob,
  startInsightsJob,
  startAutopilotJob,
};
