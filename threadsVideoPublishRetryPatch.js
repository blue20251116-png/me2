'use strict';

// Retry a VIDEO carousel child once if Meta accepts creation but later marks
// processing ERROR/EXPIRED/timeout. If the retry also fails, abort the whole
// post so a scheduled VIDEO post is never silently published as image-only.
// Source-shape mismatch remains fail-open for startup safety.

const fs = require('fs');
const path = require('path');

if (!global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__) {
  global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__ = true;

  try {
    const target = path.join(__dirname, 'threadsApi.js');
    let source = fs.readFileSync(target, 'utf8');

    if (source.includes('[Threads][CAROUSEL_VIDEO_RECREATE]')) {
      console.log('[Threads][VIDEO PUBLISH RETRY] already applied');
    } else {
      const targetBlock = /  const readyChildren=\[\];const failedChildren=\[\];\n  for\(const child of children\)\{[\s\S]*?\n  \}\n  if\(failedChildren\.length\)/;

      const newBlock = `  const readyChildren=[];const failedChildren=[];
  for(const child of children){
    try{
      await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:\`CAROUSEL_\${child.type}\`});
      readyChildren.push(child);
    }catch(err){
      if(!isMediaProcessingError(err))throw err;

      if(child.type==='VIDEO'){
        console.warn(\`[Threads][CAROUSEL_VIDEO_RECREATE] 1차 VIDEO 처리 실패 → 2500ms 후 새 child 1회 재생성 oldId=\${child.id} url=\${child.url} reason="\${err.message}"\`);
        await sleep(2500);
        try{
          const retryChild=await createCarouselChildContainer(accountId,{type:'VIDEO',url:child.url},accessToken,{maxTries:3});
          await waitForContainerReady(retryChild.id,accessToken,{maxTries:40,waitMs:2000,label:'CAROUSEL_VIDEO_RETRY'});
          readyChildren.push(retryChild);
          console.log(\`[Threads][CAROUSEL_VIDEO_RECREATE] 성공 oldId=\${child.id} newId=\${retryChild.id}\`);
          continue;
        }catch(retryErr){
          if(!isMediaProcessingError(retryErr)&&!isTransientThreadsError(retryErr))throw retryErr;
          console.error(\`[Threads][CAROUSEL_VIDEO_ABORT] 2차 VIDEO도 실패 → 이미지 단독 발행 금지 oldId=\${child.id} url=\${child.url} reason="\${retryErr.message}"\`);
          throw mediaProcessingError('예약글 VIDEO 처리 2차 실패 - 이미지 단독 발행을 차단했습니다',{type:'VIDEO',url:child.url,originalError:retryErr});
        }
      }

      failedChildren.push({child,err});
      console.warn(\`[Threads][CAROUSEL_ITEM_SKIP] \${child.type} 처리 실패 → 제외 id=\${child.id} url=\${child.url} reason="\${err.message}"\`);
    }
  }
  if(failedChildren.length)`;

      if (!targetBlock.test(source)) {
        console.warn('[Threads][VIDEO PUBLISH RETRY] target block not found → patch skipped, startup preserved');
      } else {
        source = source.replace(targetBlock, newBlock);
        fs.writeFileSync(target, source, 'utf8');
        console.log('[Threads][VIDEO PUBLISH RETRY] VIDEO processing fail → recreate once, then abort instead of image-only fallback');
      }
    }
  } catch (err) {
    console.warn(`[Threads][VIDEO PUBLISH RETRY] patch error → skipped without startup failure reason="${err.message}"`);
  }
}
