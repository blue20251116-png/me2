const Module = require('module');
const path = require('path');

const originalJsLoader = Module._extensions['.js'];

Module._extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'scheduler.js') {
    return originalJsLoader(mod, filename);
  }

  const fs = require('fs');
  let source = fs.readFileSync(filename, 'utf8');
  let changed = 0;

  // 댓글은 본문 발행 5분 뒤 딱 1회만 실행한다.
  // 실패한 댓글(status='failed')은 자동 재시도 대상에서 완전히 제외한다.
  // 과거 DB에 남아 있는 failed 댓글도 다시 건드리지 않는다.
  const oldQuery = "AND comment_status='failed' AND comment_media_id IS NULL AND COALESCE(comment_retry_count,0)<3 AND (comment_next_retry_at IS NULL OR comment_next_retry_at<=?)";
  const newQuery = "AND comment_status='pending' AND comment_media_id IS NULL AND (NULLIF(TRIM(COALESCE(link,'')),'') IS NOT NULL OR NULLIF(TRIM(COALESCE(recipe_comment_text,'')),'') IS NOT NULL) AND comment_next_retry_at IS NOT NULL AND comment_next_retry_at<=?";
  if (source.includes(oldQuery)) {
    source = source.replace(oldQuery, newQuery);
    changed++;
  }

  // pending 댓글을 처리할 때 기존 '재시도' 로그 대신 5분 지연 실행 로그로 표시한다.
  const oldRetryLog = "console.log(`[댓글 재시도] account #${account.id} post #${post.id} retry=${Number(post.comment_retry_count||0)+1}/3`);";
  const newRetryLog = "console.log(`[댓글 5분 지연 실행] account #${account.id} post #${post.id}`);";
  if (source.includes(oldRetryLog)) {
    source = source.replace(oldRetryLog, newRetryLog);
    changed++;
  }

  const oldImmediate = "await new Promise(r=>setTimeout(r,3000));const freshPost=db.prepare(`SELECT * FROM posts WHERE id=?`).get(post.id)||post;await postAffiliateComment(account,freshPost,mediaId);";
  const newDelayed = "const hasAutoComment=!!post.auto_comment_enabled&&!!(post.link||post.recipe_comment_text);if(hasAutoComment){const commentAt=new Date(Date.now()+5*60*1000).toISOString();db.prepare(`UPDATE posts SET comment_status='pending', comment_next_retry_at=?, comment_error_message=NULL, comment_retry_count=0 WHERE id=?`).run(commentAt,post.id);console.log(`[댓글 예약] account #${account.id} post #${post.id} - 본문 발행 5분 후 ${commentAt}`);}";
  if (source.includes(oldImmediate)) {
    source = source.replace(oldImmediate, newDelayed);
    changed++;
  }

  if (changed !== 3) {
    console.warn(`[Comment][5MIN PATCH] scheduler 패치 일부 미적용 changed=${changed}/3`);
  } else {
    console.log('[Comment][5MIN PATCH] 본문 발행 후 5분 뒤 댓글 1회만 실행 + 자동 재시도 비활성화');
  }

  mod._compile(source, filename);
};
