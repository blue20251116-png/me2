const fs = require('fs');
const path = require('path');
const Module = require('module');

const realLoader = Module._extensions['.js'];
let applied = false;

Module._extensions['.js'] = function noTextFallbackLoader(mod, filename){
  if(path.basename(filename)!=='threadsApi.js') return realLoader(mod, filename);
  let src=fs.readFileSync(filename,'utf8');
  let changes=0;
  const replace=(from,to)=>{if(src.includes(from)){src=src.replace(from,to);changes++;}};

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

  applied=true;
  console.log(`[Threads][NO TEXT FALLBACK PATCH] 원본 미디어 실패 시 TEXT 발행 금지 replacements=${changes}`);
  mod._compile(src,filename);
};

process.on('exit',()=>{if(!applied){} });
