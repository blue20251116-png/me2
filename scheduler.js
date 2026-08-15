const cron = require('node-cron');
const { db, listAllAccountsForSystem, getAccount, canPublish, getPublicBaseUrlForAccount } = require('./db');
const { publishPost, publishCarouselPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateCaption, suggestKeywordCandidates } = require('./aiCaption');
const { rankKeywordsByTrend } = require('./naverTrends');
const { generateScene, generateLifestyleImage } = require('./aiImage');

// 링크를 계정별 안내문구 템플릿에 끼워서 댓글용 텍스트 생성
function buildCommentText(account, link) {
  const template = account.coupang_disclosure_template || '{link}';
  return template.replace('{link}', link);
}

// 본문 발행 성공 직후 호출: 링크가 있고 자동댓글이 켜져 있으면 안내문구+링크를 댓글로 등록
async function postAffiliateComment(account, post, parentMediaId) {
  if (!post.link || !post.auto_comment_enabled) return;
  try {
    const commentText = buildCommentText(account, post.link);
    const commentMediaId = await publishReply(account.id, parentMediaId, commentText);
    db.prepare(
      `UPDATE posts SET comment_status = 'posted', comment_media_id = ?, comment_posted_at = ? WHERE id = ?`
    ).run(commentMediaId, new Date().toISOString(), post.id);
    console.log(`[댓글 등록 완료] account #${account.id} post #${post.id} -> comment ${commentMediaId}`);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    db.prepare(`UPDATE posts SET comment_status = 'failed', comment_error_message = ? WHERE id = ?`).run(
      msg,
      post.id
    );
    console.error(`[댓글 등록 실패] account #${account.id} post #${post.id}:`, msg);
  }
}

// 1분마다: 모든 계정의 발행 시각이 지난 pending 글을 발행 (+ 링크 있으면 댓글에 안내문구 자동 등록)
function startPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const accounts = listAllAccountsForSystem();

    for (const accountSummary of accounts) {
      const account = getAccount(accountSummary.id);
      const duePosts = db
        .prepare(
          `SELECT * FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC`
        )
        .all(account.id, now);

      for (const post of duePosts) {
        // 회원 전체 계정 합산 하루 발행 한도 체크 (계정별이 아니라 회원 전체 합산 — 요금제 정책)
        if (account.user_id && !canPublish(account.user_id)) {
          db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(
            '오늘 발행 가능 횟수를 다 썼습니다 (요금제 하루 한도 초과)',
            post.id
          );
          console.log(`[발행 차단] account #${account.id} post #${post.id}: 하루 발행 한도 초과`);
          continue;
        }
        try {
          // extra_image_url이 있으면(라이프스타일+상세페이지 2장) 캐러셀로, 없으면 기존처럼 단일 이미지/영상으로 발행
          const mediaId =
            post.image_url && post.extra_image_url
              ? await publishCarouselPost(account.id, {
                  text: post.text,
                  imageUrls: [post.image_url, post.extra_image_url],
                })
              : await publishPost(account.id, {
                  text: post.text,
                  imageUrl: post.image_url,
                  videoUrl: post.video_url,
                });
          db.prepare(
            `UPDATE posts SET status = 'posted', threads_media_id = ?, posted_at = ? WHERE id = ?`
          ).run(mediaId, new Date().toISOString(), post.id);
          db.prepare(
            `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes) VALUES (?, 0, 0, 0, 0, 0)
             ON CONFLICT(post_id) DO NOTHING`
          ).run(post.id);
          console.log(`[발행 완료] account #${account.id} post #${post.id} -> media ${mediaId}`);

          await new Promise((r) => setTimeout(r, 3000));
          await postAffiliateComment(account, post, mediaId);
        } catch (err) {
          const apiErr = err.response?.data?.error;
          const msg = apiErr
            ? `${apiErr.message} (type: ${apiErr.type || '-'}, code: ${apiErr.code || '-'}${
                apiErr.error_subcode ? ', subcode: ' + apiErr.error_subcode : ''
              })`
            : err.message;
          db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, post.id);
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

// 10분마다: 모든 계정에서 오늘 발행된 글들의 인사이트(조회수 등) 갱신
function startInsightsJob() {
  cron.schedule('*/10 * * * *', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const accounts = listAllAccountsForSystem();

    for (const accountSummary of accounts) {
      const postedToday = db
        .prepare(
          `SELECT * FROM posts WHERE account_id = ? AND status = 'posted' AND posted_at >= ? AND threads_media_id IS NOT NULL`
        )
        .all(accountSummary.id, startOfDay.toISOString());

      for (const post of postedToday) {
        try {
          const stats = await getMediaInsights(accountSummary.id, post.threads_media_id);
          db.prepare(
            `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(post_id) DO UPDATE SET
               views = excluded.views, likes = excluded.likes, replies = excluded.replies,
               reposts = excluded.reposts, quotes = excluded.quotes, updated_at = excluded.updated_at`
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

module.exports = { startPublishJob, startInsightsJob, startAutopilotJob };

// 60~75분 사이 랜덤 간격 (분 단위) — 매번 정확히 같은 주기로 안 돌게 해서 덜 봇처럼 보이게 함
function randomIntervalMinutes() {
  return 60 + Math.random() * 15;
}

// 오토파일럿이 매번 랜덤으로 골라볼 타겟 후보 (전체 포함, 다양성 확보용)
const AUTOPILOT_TARGETS = ['전체', '20대 여자', '20대 남자', '30대 여자', '30대 남자', '40대 이상'];

// 쿠팡 골드박스(오늘의 특가)에서 우선 고르고 -> 실패하면 카테고리 베스트 랭킹 -> 그마저 실패하면
// AI 키워드 검색까지, 순서대로 폴백한다. 골드박스는 카테고리를 우리가 정하지 않고 쿠팡이 실제로 미는
// 특가 상품을 통째로 주기 때문에, 식품 등 특정 카테고리 비중을 우리가 손으로 정할 필요가 없다 —
// 실제로 식품이 잘 팔리는 날엔 골드박스에도 식품이 많이 걸리고, 그렇게 자연스럽게 반영된다
// (실제 발행/댓글 등록은 여기서 하지 않고, 방금 만든 예약글을 startPublishJob이 곧바로 집어서 처리함)
async function runAutopilotOnce(account) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];

  let picked;
  let keyword;
  let trendNote;

  try {
    // 1순위: 골드박스 — 카테고리 상관없이 쿠팡이 지금 실제로 미는 특가/베스트 상품
    const goldbox = await coupangApi.getGoldboxProducts(account.id, 30);
    if (!goldbox.length) throw new Error('골드박스 상품 목록이 비어있습니다');

    const pool = goldbox.slice(0, Math.min(15, goldbox.length));
    picked = pool[Math.floor(Math.random() * pool.length)];
    keyword = picked.name;
    trendNote = `쿠팡 골드박스 특가${picked.discountRate ? ` (${picked.discountRate}% 할인)` : ''}`;
  } catch (goldboxErr) {
    console.error(
      `[골드박스 조회 실패, 카테고리 베스트 랭킹으로 폴백] account #${account.id}:`,
      goldboxErr.response?.data || goldboxErr.message
    );

    try {
      // 2순위: 카테고리 베스트 랭킹 — 13개 카테고리 중 균등 랜덤 (특정 카테고리 가중치 없음)
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
        console.error(`[트렌드 비교 실패] account #${account.id}:`, err.response?.data || err.message);
        // 트렌드 비교가 실패해도 AI가 고른 1순위 키워드로 그냥 진행
      }

      const products = await coupangApi.searchProducts(account.id, keyword, 8);
      if (!products.length) throw new Error(`"${keyword}" 검색 결과가 없습니다`);

      const pool = products.slice(0, Math.min(5, products.length));
      picked = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  const texts = await generateCaption(account.id, { productName: picked.name, price: picked.price, target });
  const text = texts[Math.floor(Math.random() * texts.length)];

  // 1장(원본 상품컷)이 기본값. 라이프스타일 이미지 생성이 성공하면
  // [라이프스타일, 상세페이지 사진] 2장 캐러셀로 업그레이드하고, 실패하면 조용히 원본 1장 폴백으로 유지한다.
  let imageUrl = picked.image;
  let extraImageUrl = null;
  let imageMode = '원본 상품컷 1장';

  try {
    const publicBaseUrl = getPublicBaseUrlForAccount(account);
    const scene = await generateScene(account.id, { productName: picked.name, price: picked.price, target });
    const lifestyle = await generateLifestyleImage(
      account.id,
      { productName: picked.name, productImageUrl: picked.image, scene },
      publicBaseUrl
    );
    const lifestyleUrl = lifestyle.images?.[0]?.url;
    if (!lifestyleUrl) throw new Error('라이프스타일 이미지 URL이 비어있습니다');

    // 상세페이지 크롤링은 쿠팡이 서버 IP발 요청을 봇으로 차단해서 계속 실패했음.
    // 크롤링할 필요 없이, 쿠팡파트너스 Open API가 이미 정식으로 준 원본 상품 썸네일(picked.image)을
    // 2번째 캐러셀 이미지로 그대로 쓴다 — 실패할 여지 자체가 없음
    imageUrl = lifestyleUrl;
    extraImageUrl = picked.image;
    imageMode = '라이프스타일+원본 상품컷 2장 캐러셀';
  } catch (imgErr) {
    console.error(`[라이프스타일 이미지 생성 실패, 원본 사진으로 폴백] account #${account.id}:`, imgErr.message);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO posts (text, link, image_url, extra_image_url, scheduled_at, auto_comment_enabled, comment_status, account_id)
     VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`
  ).run(text, picked.url, imageUrl, extraImageUrl, now, account.id);

  db.prepare(`UPDATE accounts SET autopilot_last_keyword = ?, autopilot_last_target = ? WHERE id = ?`).run(
    keyword,
    target,
    account.id
  );
  console.log(
    `[자동발행 예약] account #${account.id} target="${target}" keyword="${keyword}" (${trendNote}) product="${picked.name}" image="${imageMode}"`
  );
}

// 1분마다: 자동발행이 켜진 계정 중 예정 시각이 지난 계정을 골라 새 글을 하나 만들고,
// 다음 실행 시각을 60~75분 뒤 랜덤으로 다시 잡음
function startAutopilotJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const dueAccounts = db
      .prepare(
        `SELECT * FROM accounts WHERE autopilot_enabled = 1 AND (autopilot_next_at IS NULL OR autopilot_next_at <= ?)`
      )
      .all(now);

    for (const account of dueAccounts) {
      const nextAt = new Date(Date.now() + randomIntervalMinutes() * 60000).toISOString();
      // 실행 전에 먼저 다음 시각을 잡아둬서, 오래 걸리는 실패가 반복 재시도로 겹치지 않게 함
      db.prepare(`UPDATE accounts SET autopilot_next_at = ? WHERE id = ?`).run(nextAt, account.id);
      try {
        await runAutopilotOnce(account);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error(`[자동발행 실패] account #${account.id}:`, msg);
      }
    }
  });
}
