'use strict';

const Module = require('module');
const originalLoader = Module._extensions['.js'];
let applied = false;

function transformScheduler(src) {
  if (applied) return src;
  let out = src;

  out = out
    .split("path.join(__dirname, 'uploads')").join("path.join(__dirname, 'db', 'uploads')")
    .split("path.join(__dirname,'uploads')").join("path.join(__dirname,'db','uploads')");
  console.log('[Media][PERSIST] scheduler uploads → db/uploads (final loader)');

  const bodyRe = /function splitThreadsSentences\(text\)\{[\s\S]*?function formatThreadsBody\(text\)\{[\s\S]*?return paragraphs\.filter\(Boolean\)\.slice\(0,5\)\.join\('\\n\\n'\)\.trim\(\);\}/;
  if (bodyRe.test(out)) {
    const replacement = `function splitThreadsSentences(text){return String(text||'').replace(/\\r/g,'').replace(/\\\\n/g,'\\n').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().split('\\n').map(x=>x.trim()).filter(Boolean);}\nfunction formatThreadsBody(text){return String(text||'').replace(/\\r/g,'').replace(/\\\\n/g,'\\n').replace(/,/g,'').replace(/(^|[^0-9])\\.(?![0-9])/g,'$1').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}`;
    out = out.replace(bodyRe, replacement);
    console.log('[Threads][BODY PRESERVE] scheduler 예약 저장 시 생성된 줄/빈줄 그대로 보존');
  } else {
    console.warn('[Threads][BODY PRESERVE] scheduler format block not found');
  }

  const disclosureOld = "function buildDisclosureOnly(account){const t=String(account.coupang_disclosure_template||`${DEFAULT_COUPANG_DISCLOSURE}\\n\\n{link}`);return t.replace(/\\{link\\}/g,'').replace(/\\n{3,}/g,'\\n\\n').trim();}";
  const disclosureNew = "function buildDisclosureOnly(account){return DEFAULT_COUPANG_DISCLOSURE;}";
  if (out.includes(disclosureOld)) out = out.replace(disclosureOld, disclosureNew);

  const doubleLinkRe = /function buildDoubleLinkComment\(account,prefix,link,maxLength=490\)\{[\s\S]*?return out;\}/;
  if (doubleLinkRe.test(out)) {
    const replacement = [
      "function extractFirstHttpUrl(value){const m=String(value||'').match(/https?:\\/\\/[^\\s<>'\\\"\\])}]+/i);return m?m[0].replace(/[.,;]+$/,''):'';}",
      "function sanitizeCommentPrefix(value){",
      "  const raw=String(value||'').replace(/\\r/g,'').replace(/\\n{3,}/g,'\\n\\n').trim();",
      "  if(!raw)return '';",
      "  const isRecipe=/(🥘|🍳|재료|만드는\\s*법|조리\\s*법)/i.test(raw);",
      "  if(isRecipe)return raw.replace(/^\\s*✅?\\s*핵심만\\s*[:：]?\\s*\\n?/i,'').trim();",
      "  const lines=raw.split('\\n').map(x=>x.replace(/^\\s*(?:✅\\s*)?(?:핵심만\\s*[:：]?\\s*)?/i,'').replace(/^\\s*[-▪•·*]+\\s*/,'').trim()).filter(Boolean);",
      "  const clean=[];for(const line of lines){if(!clean.includes(line))clean.push(line);if(clean.length>=3)break;}",
      "  return clean.join('\\n').slice(0,120).trim();",
      "}",
      "function buildDoubleLinkComment(account,prefix,link,maxLength=450){",
      "  const cap=Math.min(450,Math.max(1,Number(maxLength)||450));",
      "  const l=extractFirstHttpUrl(link);",
      "  if(!l)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');",
      "  const disclosure=isCoupangLink(l)?DEFAULT_COUPANG_DISCLOSURE:'';",
      "  const tail=[l,l,disclosure].filter(Boolean).join('\\n\\n');",
      "  if(tail.length>cap)throw new Error('쿠팡 링크 자체가 너무 길어 댓글을 만들 수 없습니다: '+tail.length+'자');",
      "  const available=Math.max(0,cap-tail.length-2);",
      "  const safePrefix=sanitizeCommentPrefix(prefix);",
      "  const head=compactRecipePrefix(safePrefix,available);",
      "  const comment=[head,tail].filter(Boolean).join('\\n\\n');",
      "  if(comment.length>cap)throw new Error('댓글 길이 조립 오류: '+comment.length+'/'+cap+'자');",
      "  return comment;",
      "}"
    ].join('\n');
    out = out.replace(doubleLinkRe, replacement);
    console.log('[Comment][COMPACT] 자연어/레시피 prefix + 링크 2개 + 공식 고지문 + 450자 하드캡');
  } else {
    console.warn('[Comment][COMPACT] buildDoubleLinkComment block not found');
  }

  const buildCommentOld = "async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(post.recipe_comment_text||'',490);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,490);}";
  const buildCommentNew = "async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(sanitizeCommentPrefix(post.recipe_comment_text||''),450);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,450);}";
  if (out.includes(buildCommentOld)) out = out.replace(buildCommentOld, buildCommentNew);
  else console.warn('[Comment][COMPACT] buildCommentText block not found');

  const retryFnRe = /async function retryFailedComments\(account,now\)\{[\s\S]*?\}\nfunction startPublishJob\(\)/;
  if (retryFnRe.test(out)) {
    const delayedRunner = "async function retryFailedComments(account,now){const pending=db.prepare(`SELECT * FROM posts WHERE account_id=? AND status='posted' AND auto_comment_enabled=1 AND comment_status='pending' AND comment_media_id IS NULL AND threads_media_id IS NOT NULL AND comment_next_retry_at IS NOT NULL AND comment_next_retry_at<=? ORDER BY posted_at ASC LIMIT 3`).all(account.id,now);for(const post of pending){console.log(`[댓글 5분 지연 실행] account #${account.id} post #${post.id}`);await postAffiliateComment(account,post,post.threads_media_id,{isRetry:false});await new Promise(r=>setTimeout(r,1500));}}\nfunction startPublishJob()";
    out = out.replace(retryFnRe, delayedRunner);
    console.log('[Comment][DELAY] pending 댓글만 5분 후 1회 실행');
  } else {
    console.warn('[Comment][DELAY] retryFailedComments block not found');
  }

  const immediatePattern = /await new Promise\(r=>setTimeout\(r,3000\)\);const freshPost=db\.prepare\(`SELECT \* FROM posts WHERE id=\?`\)\.get\(post\.id\)\|\|post;await postAffiliateComment\(account,freshPost,mediaId\);/;
  if (immediatePattern.test(out)) {
    const delayedCode = "const hasAutoComment=!!post.auto_comment_enabled&&!!(post.link||post.recipe_comment_text);if(hasAutoComment){const commentAt=new Date(Date.now()+5*60*1000).toISOString();db.prepare(`UPDATE posts SET comment_status='pending', comment_next_retry_at=?, comment_error_message=NULL, comment_retry_count=0 WHERE id=?`).run(commentAt,post.id);console.log(`[댓글 예약] account #${account.id} post #${post.id} - 본문 발행 5분 후 ${commentAt}`);}";
    out = out.replace(immediatePattern, delayedCode);
    console.log('[Comment][DELAY] 본문 직후 즉시댓글 제거 · 5분 예약 저장');
  } else {
    console.warn('[Comment][DELAY] immediate comment block not found');
  }

  const retryOld = "const retryCount=Number(post.comment_retry_count||0)+1;const nextRetry=retryCount<3?nextCommentRetryIso(retryCount):null;";
  const retryNew = "const retryCount=3;const nextRetry=null;";
  if (out.includes(retryOld)) {
    out = out.replace(retryOld, retryNew);
    console.log('[Comment][NO RETRY] 댓글 실패 시 자동 재시도 없음');
  } else {
    console.warn('[Comment][NO RETRY] retry counter block not found');
  }

  applied = true;
  return out;
}

Module._extensions['.js'] = function bodyPreserveLoader(mod, filename) {
  if (filename.endsWith('/scheduler.js') || filename.endsWith('\\scheduler.js')) {
    const fs = require('fs');
    const src = fs.readFileSync(filename, 'utf8');
    mod._compile(transformScheduler(src), filename);
    return;
  }
  return originalLoader(mod, filename);
};

console.log('[Threads][BODY PRESERVE] patch armed · comment 5min/once/compact450 · persistent scheduler uploads enabled');
