'use strict';

// If Meta accepts a VIDEO carousel child but later marks it ERROR/EXPIRED,
// normalize the local MP4 to a Meta-friendly H.264/AAC faststart file and
// recreate the child with the NEW public URL. This also rescues already-
// reserved posts that point at older imported MP4 files.

const fs = require('fs');
const path = require('path');

if (!global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__) {
  global.__ME2_THREADS_VIDEO_PUBLISH_RETRY_PATCH__ = true;

  try {
    const target = path.join(__dirname, 'threadsApi.js');
    let source = fs.readFileSync(target, 'utf8');

    if (source.includes('[Threads][CAROUSEL_VIDEO_NORMALIZE]')) {
      console.log('[Threads][VIDEO PUBLISH RETRY] normalize retry already applied');
    } else {
      // Inject helpers into threadsApi.js runtime source. videoEditor already
      // ships with ffmpeg/ffprobe support and writes H.264/yuv420p/AAC/faststart.
      const importAnchor = "const { getAccount, getSystemApiSettings } = require('./db');";
      if (!source.includes(importAnchor)) throw new Error('threadsApi import anchor missing');
      source = source.replace(importAnchor, `${importAnchor}\nconst __me2Fs = require('fs');\nconst __me2Path = require('path');\nconst { editVideo: __me2EditVideo } = require('./videoEditor');`);

      const sleepAnchor = "const sleep=ms=>new Promise(r=>setTimeout(r,ms));";
      if (!source.includes(sleepAnchor)) throw new Error('threadsApi sleep anchor missing');
      source = source.replace(sleepAnchor, `${sleepAnchor}\n\nasync function __me2NormalizeCarouselVideoUrl(rawUrl){\n  try{\n    const u=new URL(String(rawUrl||''));\n    const marker='/uploads/';\n    const idx=u.pathname.indexOf(marker);\n    if(idx<0)throw new Error('로컬 uploads URL이 아닙니다');\n    const relative=decodeURIComponent(u.pathname.slice(idx+marker.length));\n    const uploadsRoot=__me2Path.resolve(__dirname,'uploads');\n    const inputPath=__me2Path.resolve(uploadsRoot,relative);\n    if(!inputPath.startsWith(uploadsRoot+__me2Path.sep)&&inputPath!==uploadsRoot)throw new Error('잘못된 uploads 경로입니다');\n    if(!__me2Fs.existsSync(inputPath))throw new Error('원본 영상 파일이 서버에 없습니다');\n    const normalized=await __me2EditVideo({inputPath,outputDir:uploadsRoot,start:0,end:null,mute:false});\n    const nextUrl=\`\${u.protocol}//\${u.host}/uploads/\${encodeURIComponent(normalized.filename)}\`;\n    console.log(\`[Threads][CAROUSEL_VIDEO_NORMALIZE] success old=\${rawUrl} new=\${nextUrl} size=\${normalized.size} duration=\${Number(normalized.duration||0).toFixed(2)}s\`);\n    return nextUrl;\n  }catch(err){\n    console.error(\`[Threads][CAROUSEL_VIDEO_NORMALIZE] failed url=\${rawUrl} reason=\"\${err.message}\"\`);\n    return String(rawUrl||'');\n  }\n}`);

      const targetBlock = /  const readyChildren=\[\];const failedChildren=\[\];\n  for\(const child of children\)\{[\s\S]*?\n  \}\n  if\(failedChildren\.length\)/;

      const newBlock = `  const readyChildren=[];const failedChildren=[];
  for(const child of children){
    try{
      await waitForContainerReady(child.id,accessToken,{maxTries:child.type==='VIDEO'?40:20,waitMs:child.type==='VIDEO'?2000:1000,label:\`CAROUSEL_\${child.type}\`});
      readyChildren.push(child);
    }catch(err){
      if(!isMediaProcessingError(err))throw err;

      if(child.type==='VIDEO'){
        console.warn(\`[Threads][CAROUSEL_VIDEO_RECREATE] 1차 VIDEO 처리 실패 → ffmpeg 정상화 후 새 child 재생성 oldId=\${child.id} url=\${child.url} reason="\${err.message}"\`);
        let retryUrl=child.url;
        try{retryUrl=await __me2NormalizeCarouselVideoUrl(child.url);}catch{}
        await sleep(1200);
        try{
          const retryChild=await createCarouselChildContainer(accountId,{type:'VIDEO',url:retryUrl},accessToken,{maxTries:3});
          await waitForContainerReady(retryChild.id,accessToken,{maxTries:40,waitMs:2000,label:'CAROUSEL_VIDEO_RETRY'});
          readyChildren.push(retryChild);
          console.log(\`[Threads][CAROUSEL_VIDEO_RECREATE] 성공 oldId=\${child.id} newId=\${retryChild.id} normalized=\${retryUrl!==child.url?'yes':'no'}\`);
          continue;
        }catch(retryErr){
          if(!isMediaProcessingError(retryErr)&&!isTransientThreadsError(retryErr))throw retryErr;
          console.error(\`[Threads][CAROUSEL_VIDEO_ABORT] 정상화 후 VIDEO도 실패 → 이미지 단독 발행 금지 oldId=\${child.id} oldUrl=\${child.url} retryUrl=\${retryUrl} reason="\${retryErr.message}"\`);
          throw mediaProcessingError('예약글 VIDEO 정상화 재시도 실패 - 이미지 단독 발행을 차단했습니다',{type:'VIDEO',url:retryUrl,originalError:retryErr});
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
        console.log('[Threads][VIDEO PUBLISH RETRY] VIDEO processing fail → ffmpeg normalize → recreate with new URL → abort only if normalized retry fails');
      }
    }
  } catch (err) {
    console.warn(`[Threads][VIDEO PUBLISH RETRY] patch error → skipped without startup failure reason="${err.message}"`);
  }
}
