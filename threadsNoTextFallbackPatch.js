const fs = require('fs');
const path = require('path');
const Module = require('module');

const realLoader = Module._extensions['.js'];
const appliedFiles = new Set();

Module._extensions['.js'] = function noTextFallbackLoader(mod, filename){
  const base = path.basename(filename);
  if(base !== 'threadsApi.js' && base !== 'scheduler.js') return realLoader(mod, filename);

  let src = fs.readFileSync(filename,'utf8');
  let changes = 0;
  const replace=(from,to)=>{if(src.includes(from)){src=src.replace(from,to);changes++;}};

  if(base === 'threadsApi.js') {
    replace(
      "catch(err){if(!isMediaProcessingError(err)&&!isTransientThreadsError(err))throw err;console.warn(`[Threads][MEDIA_FALLBACK] 단일 ${items[0].type} 실패 → TEXT 발행 url=${items[0].url} reason=\"${err.message}\"`);return publishPost(accountId,{text});}",
      "catch(err){console.error(`[Threads][STRICT PUBLISH] 단일 ${items[0].type} 실패 → TEXT fallback 금지 url=${items[0].url} reason=\"${err.message}\"`);throw err;}"
    );
    replace(
      "if(!children.length){console.warn('[Threads][CAROUSEL_FALLBACK] 자식 미디어 생성 전부 실패 → TEXT 발행');return publishPost(accountId,{text});}",
      "if(!children.length){throw new Error('Threads 원본 미디어 컨테이너 생성이 전부 실패했습니다. TEXT fallback은 금지됩니다');}"
    );
    replace(
      "if(!readyChildren.length){console.warn('[Threads][CAROUSEL_FALLBACK] 모든 미디어 처리 실패 → TEXT 발행');return publishPost(accountId,{text});}",
      "if(!readyChildren.length){throw new Error('Threads 원본 미디어 처리가 전부 실패했습니다. TEXT fallback은 금지됩니다');}"
    );
    replace(
      "catch(err){if(!isMediaProcessingError(err)&&!isTransientThreadsError(err))throw err;console.warn(`[Threads][CAROUSEL_FALLBACK] 남은 ${survivor.type}도 실패 → TEXT 발행 reason=\"${err.message}\"`);return publishPost(accountId,{text});}",
      "catch(err){console.error(`[Threads][STRICT PUBLISH] 남은 ${survivor.type}도 실패 → TEXT fallback 금지 reason=\"${err.message}\"`);throw err;}"
    );
    replace(
      "catch(singleErr){if(!isMediaProcessingError(singleErr)&&!isTransientThreadsError(singleErr))throw singleErr;console.warn(`[Threads][CAROUSEL_PARENT_FALLBACK] 단일 미디어도 실패 → TEXT 발행 reason=\"${singleErr.message}\"`);return publishPost(accountId,{text});}",
      "catch(singleErr){console.error(`[Threads][STRICT PUBLISH] 단일 미디어도 실패 → TEXT fallback 금지 reason=\"${singleErr.message}\"`);throw singleErr;}"
    );
  }

  if(base === 'scheduler.js') {
    replace(
      "    const hadMedia=!!(post.video_url||post.image_url||post.extra_image_url);\n    if(!hadMedia||!mediaErrorLooksRecoverable(err))throw err;\n    const reason=err.response?.data?.error?.message||err.message;\n    console.warn(`[Threads][POST_MEDIA_FALLBACK] post #${post.id} 미디어 발행 실패 → TEXT 재시도 reason=\"${reason}\"`);\n    return publishPost(account.id,{text:post.text,imageUrl:null,videoUrl:null});",
      "    const hadMedia=!!(post.video_url||post.image_url||post.extra_image_url);\n    if(!hadMedia)throw err;\n    const reason=err.response?.data?.error?.message||err.message;\n    console.error(`[Threads][POST_MEDIA_STRICT] post #${post.id} 미디어 발행 실패 → TEXT fallback 금지 reason=\"${reason}\"`);\n    throw err;"
    );
  }

  appliedFiles.add(base);
  console.log(`[Threads][NO TEXT FALLBACK PATCH V2] file=${base} replacements=${changes}`);
  mod._compile(src,filename);
};
