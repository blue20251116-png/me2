'use strict';

// If a VIDEO carousel child is created successfully but Meta later marks that
// container ERROR/EXPIRED/timed-out, recreate the VIDEO child once from the
// same public URL and wait again before allowing the existing image fallback.
// This keeps the current "publish something" fallback, but gives video a real
// second processing attempt instead of dropping it immediately.

const fs = require('fs');
const path = require('path');

if (!global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__) {
  global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__ = true;

  const target = path.join(__dirname, 'threadsApi.js');
  let source = fs.readFileSync(target, 'utf8');

  if (source.includes('[Threads][CAROUSEL_VIDEO_RECREATE]')) {
    console.log('[Threads][VIDEO PUBLISH RETRY] already applied');
  } else {
    const oldBlock = "  const readyChildren=[];const failedChildren=[];\n  for(const child of children){\n    try{await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:`CAROUSEL_${child.type}`});readyChildren.push(child);}\n    catch(err){if(!isMediaProcessingError(err))throw err;failedChildren.push({child,err});console.warn(`[Threads][CAROUSEL_ITEM_SKIP] ${child.type} 처리 실패 → 제외 id=${child.id} url=${child.url} reason=\\\"${err.message}\\\"`);}\n  }";

    const newBlock = "  const readyChildren=[];const failedChildren=[];\n  for(const child of children){\n    try{\n      await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:`CAROUSEL_${child.type}`});\n      readyChildren.push(child);\n    }catch(err){\n      if(!isMediaProcessingError(err))throw err;\n\n      // VIDEO는 컨테이너 생성 성공 뒤 Meta 처리 단계에서 일시적으로 ERROR가 날 수 있다.\n      // 바로 이미지만 발행하지 않고 같은 URL로 새 child를 한 번 재생성해서 다시 확인한다.\n      if(child.type==='VIDEO'){\n        console.warn(`[Threads][CAROUSEL_VIDEO_RECREATE] 1차 VIDEO 처리 실패 → 2500ms 후 새 child 1회 재생성 oldId=${child.id} url=${child.url} reason=\\\"${err.message}\\\"`);\n        await sleep(2500);\n        try{\n          const retryChild=await createCarouselChildContainer(accountId,{type:'VIDEO',url:child.url},accessToken,{maxTries:3});\n          await waitForContainerReady(retryChild.id,accessToken,{maxTries:40,waitMs:2000,label:'CAROUSEL_VIDEO_RETRY'});\n          readyChildren.push(retryChild);\n          console.log(`[Threads][CAROUSEL_VIDEO_RECREATE] 성공 oldId=${child.id} newId=${retryChild.id}`);\n          continue;\n        }catch(retryErr){\n          if(!isMediaProcessingError(retryErr)&&!isTransientThreadsError(retryErr))throw retryErr;\n          failedChildren.push({child,err:retryErr});\n          console.warn(`[Threads][CAROUSEL_VIDEO_RECREATE] 2차 VIDEO도 실패 → 기존 이미지 fallback 허용 oldId=${child.id} url=${child.url} reason=\\\"${retryErr.message}\\\"`);\n          continue;\n        }\n      }\n\n      failedChildren.push({child,err});\n      console.warn(`[Threads][CAROUSEL_ITEM_SKIP] ${child.type} 처리 실패 → 제외 id=${child.id} url=${child.url} reason=\\\"${err.message}\\\"`);\n    }\n  }";

    if (!source.includes(oldBlock)) {
      throw new Error('[Threads][VIDEO PUBLISH RETRY] threadsApi target block not found; refusing unsafe patch');
    }

    source = source.replace(oldBlock, newBlock);
    fs.writeFileSync(target, source, 'utf8');
    console.log('[Threads][VIDEO PUBLISH RETRY] VIDEO processing fail → recreate child once before image fallback');
  }
}
