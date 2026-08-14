const cron = require('node-cron');
const { db, listAccounts, getAccount } = require('./db');
const { publishPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateCaption, suggestKeywordCandidates } = require('./aiCaption');
const { rankKeywordsByTrend } = require('./naverTrends');

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
    const accounts = listAccounts();

    for (const accountSummary of accounts) {
      const account = getAccount(accountSummary.id);
      const duePosts = db
        .prepare(
          `SELECT * FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC`
        )
        .all(account.id, now);

      for (const post of duePosts) {
        try {
          const mediaId = await publishPost(account.id, {
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
    const accounts = listAccounts();

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

// AI가 키워드 후보 5개 정하기 -> (네이버 데이터랩 연동돼 있으면) 실제 검색 트렌드로 순위 매겨서 1등 선택
// -> 쿠팡 검색 -> 상위 결과 중 랜덤 픽 -> 타겟에 맞춰 글 생성 -> 예약글로 등록
// (실제 발행/댓글 등록은 여기서 하지 않고, 방금 만든 예약글을 startPublishJob이 곧바로 집어서 처리함)
async function runAutopilotOnce(account) {
  const target = AUTOPILOT_TARGETS[Math.floor(Math.random() * AUTOPILOT_TARGETS.length)];

  const candidates = await suggestKeywordCandidates(account.id, target);
  let keyword = candidates[0];
  let trendNote = '트렌드 비교 없이 AI 1순위 선택';

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
  const picked = pool[Math.floor(Math.random() * pool.length)];

  const texts = await generateCaption(account.id, { productName: picked.name, price: picked.price, target });
  const text = texts[Math.floor(Math.random() * texts.length)];

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO posts (text, link, image_url, scheduled_at, auto_comment_enabled, comment_status, account_id)
     VALUES (?, ?, ?, ?, 1, 'pending', ?)`
  ).run(text, picked.url, picked.image, now, account.id);

  db.prepare(`UPDATE accounts SET autopilot_last_keyword = ?, autopilot_last_target = ? WHERE id = ?`).run(
    keyword,
    target,
    account.id
  );
  console.log(
    `[자동발행 예약] account #${account.id} target="${target}" keyword="${keyword}" (${trendNote}) product="${picked.name}"`
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
