const Module = require('module');
const path = require('path');

const originalJsLoader = Module._extensions['.js'];

Module._extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'scheduler.js') {
    return originalJsLoader(mod, filename);
  }

  const fs = require('fs');
  let source = fs.readFileSync(filename, 'utf8');

  // 1) 댓글 처리 대상은 pending만 허용한다.
  // failed 댓글은 절대 자동 재시도하지 않는다.
  source = source.replace(
    /async function retryFailedComments\(account,now\)\{[\s\S]*?\}\nfunction startPublishJob\(\)/,
    `async function retryFailedComments(account,now){const pending=db.prepare(\`SELECT * FROM posts WHERE account_id=? AND status='posted' AND auto_comment_enabled=1 AND comment_status='pending' AND comment_media_id IS NULL AND threads_media_id IS NOT NULL AND (NULLIF(TRIM(COALESCE(link,'')),'') IS NOT NULL OR NULLIF(TRIM(COALESCE(recipe_comment_text,'')),'') IS NOT NULL) AND comment_next_retry_at IS NOT NULL AND comment_next_retry_at<=? ORDER BY posted_at ASC LIMIT 3\`).all(account.id,now);for(const post of pending){console.log(\`[댓글 5분 지연 실행] account #\${account.id} post #\${post.id}\`);await postAffiliateComment(account,post,post.threads_media_id,{isRetry:false});await new Promise(r=>setTimeout(r,1500));}}\nfunction startPublishJob()`
  );

  // 2) 본문 발행 직후 댓글을 달지 않고 5분 뒤 pending으로 예약한다.
  const immediatePattern = /await new Promise\(r=>setTimeout\(r,3000\)\);const freshPost=db\.prepare\(`SELECT \* FROM posts WHERE id=\?`\)\.get\(post\.id\)\|\|post;await postAffiliateComment\(account,freshPost,mediaId\);/;
  const delayedCode = "const hasAutoComment=!!post.auto_comment_enabled&&!!(post.link||post.recipe_comment_text);if(hasAutoComment){const commentAt=new Date(Date.now()+5*60*1000).toISOString();db.prepare(`UPDATE posts SET comment_status='pending', comment_next_retry_at=?, comment_error_message=NULL, comment_retry_count=0 WHERE id=?`).run(commentAt,post.id);console.log(`[댓글 예약] account #${account.id} post #${post.id} - 본문 발행 5분 후 ${commentAt}`);}";
  source = source.replace(immediatePattern, delayedCode);

  // 이미 다른 런타임 패치가 같은 부분을 먼저 바꾼 경우에도 최종 결과 기준으로 판단한다.
  const hasPendingOnly = source.includes("comment_status='pending' AND comment_media_id IS NULL") && !source.includes("[댓글 재시도]");
  const hasFiveMinuteSchedule = source.includes("Date.now()+5*60*1000") && source.includes("[댓글 예약]");

  if (hasPendingOnly && hasFiveMinuteSchedule) {
    console.log('[Comment][5MIN PATCH] 본문 발행 후 5분 뒤 댓글 1회만 실행 + 자동 재시도 비활성화');
  } else {
    console.warn(`[Comment][5MIN PATCH] 최종 검증 실패 pendingOnly=${hasPendingOnly} fiveMinute=${hasFiveMinuteSchedule}`);
  }

  mod._compile(source, filename);
};
