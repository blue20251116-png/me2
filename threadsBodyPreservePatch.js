'use strict';

const Module = require('module');
const originalLoader = Module._extensions['.js'];
let applied = false;

function transformScheduler(src) {
  if (applied) return src;
  let out = src;

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
  else console.warn('[Comment][COMPACT] disclosure block not found');

  const doubleLinkRe = /function buildDoubleLinkComment\(account,prefix,link,maxLength=490\)\{[\s\S]*?return out;\}/;
  if (doubleLinkRe.test(out)) {
    const replacement = `function extractFirstHttpUrl(value){const m=String(value||'').match(/https?:\\/\\/[^\\s<>'\"\\])}]+/i);return m?m[0].replace(/[.,;]+$/,''):'';}\nfunction buildDoubleLinkComment(account,prefix,link,maxLength=450){\n  const cap=Math.min(450,Math.max(1,Number(maxLength)||450));\n  const l=extractFirstHttpUrl(link);\n  if(!l)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');\n  const disclosure=isCoupangLink(l)?DEFAULT_COUPANG_DISCLOSURE:'';\n  const tail=[l,l,disclosure].filter(Boolean).join('\\n\\n');\n  if(tail.length>cap)throw new Error(\`쿠팡 링크 자체가 너무 길어 댓글을 만들 수 없습니다: \\${tail.length}자\`);\n  const available=Math.max(0,cap-tail.length-2);\n  const head=compactRecipePrefix(prefix,available);\n  let comment=[head,tail].filter(Boolean).join('\\n\\n');\n  if(comment.length>cap)comment=comment.slice(0,cap).trim();\n  return comment;\n}`;
    out = out.replace(doubleLinkRe, replacement);
    console.log('[Comment][COMPACT] 링크 1개 추출×2 + 공식 고지문 + 전체 450자 하드캡');
  } else {
    console.warn('[Comment][COMPACT] buildDoubleLinkComment block not found');
  }

  const buildCommentOld = "async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(post.recipe_comment_text||'',490);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,490);}";
  const buildCommentNew = "async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(post.recipe_comment_text||'',450);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,450);}";
  if (out.includes(buildCommentOld)) out = out.replace(buildCommentOld, buildCommentNew);
  else console.warn('[Comment][COMPACT] buildCommentText block not found');

  const retryOld = "const retryCount=Number(post.comment_retry_count||0)+1;const nextRetry=retryCount<3?nextCommentRetryIso(retryCount):null;";
  const retryNew = "const noRetry=/링크가 비어|링크 자체가 너무 길어|댓글 필수영역|댓글 최종 길이/.test(msg);const retryCount=noRetry?3:Number(post.comment_retry_count||0)+1;const nextRetry=!noRetry&&retryCount<3?nextCommentRetryIso(retryCount):null;";
  if (out.includes(retryOld)) out = out.replace(retryOld, retryNew);
  else console.warn('[Comment][COMPACT] retry block not found');

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

console.log('[Threads][BODY PRESERVE] patch armed · comment compact 450 enabled');
