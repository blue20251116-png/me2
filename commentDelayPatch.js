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

  const oldQuery = "AND comment_status='failed' AND comment_media_id IS NULL";
  const newQuery = "AND comment_status IN ('pending','failed') AND comment_media_id IS NULL";
  if (source.includes(oldQuery)) {
    source = source.replace(oldQuery, newQuery);
    changed++;
  }

  const oldImmediate = "await new Promise(r=>setTimeout(r,3000));const freshPost=db.prepare(`SELECT * FROM posts WHERE id=?`).get(post.id)||post;await postAffiliateComment(account,freshPost,mediaId);";
  const newDelayed = "const hasAutoComment=!!post.auto_comment_enabled&&!!(post.link||post.recipe_comment_text);if(hasAutoComment){const commentAt=new Date(Date.now()+5*60*1000).toISOString();db.prepare(`UPDATE posts SET comment_status='pending', comment_next_retry_at=?, comment_error_message=NULL WHERE id=?`).run(commentAt,post.id);console.log(`[댓글 예약] account #${account.id} post #${post.id} - 본문 발행 5분 후 ${commentAt}`);}";
  if (source.includes(oldImmediate)) {
    source = source.replace(oldImmediate, newDelayed);
    changed++;
  }

  if (changed !== 2) {
    console.warn(`[Comment][5MIN PATCH] scheduler 패치 일부 미적용 changed=${changed}/2`);
  } else {
    console.log('[Comment][5MIN PATCH] 본문 발행 후 댓글 5분 지연 활성화');
  }

  mod._compile(source, filename);
};
