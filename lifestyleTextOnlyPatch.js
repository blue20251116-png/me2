const fs = require('fs');
const path = require('path');

// 1) 모든 autopilot 후처리 패치가 끝난 뒤 lifestyle 결과의 미디어를 다시 비운다.
// autopilotVideoTriggerPatch 등이 sourceVideos를 되살려도 이 패치가 최종적으로 제거한다.
const engine = require('./autopilotMaterialEngine');
const previousBuildThreadsFirstAutopilot = engine.buildThreadsFirstAutopilot.bind(engine);

engine.buildThreadsFirstAutopilot = async function lifestyleTextOnlyBuild(accountId, options) {
  const result = await previousBuildThreadsFirstAutopilot(accountId, options);
  if (result?.mode !== 'lifestyle') return result;

  console.log('[Autopilot][LIFESTYLE TEXT ONLY FINAL] image/video/reference media cleared');
  return {
    ...result,
    textOnly: true,
    sourceImages: [],
    sourceVideos: [],
    referenceImage: null,
    sourceHasVideo: false,
  };
};

// 2) scheduler의 이미지 fallback 자체도 lifestyle에서는 차단한다.
// sourceImages가 비어 있을 때 product.image(쿠팡 상품 이미지)를 넣던 기존 경로를 건너뛴다.
const schedulerTarget = path.resolve(path.join(__dirname, 'scheduler.js'));
const originalReadFileSync = fs.readFileSync.bind(fs);
let schedulerPatched = false;

function transformSchedulerSource(src) {
  const marker = 'async function chooseSourceMedia(result){\n  const videos=Array.isArray(result?.sourceVideos)?result.sourceVideos.filter(Boolean):[];';
  const replacement = "async function chooseSourceMedia(result){\n  if(result?.textOnly===true||result?.mode==='lifestyle'){console.log('[Autopilot][LIFESTYLE TEXT ONLY FINAL] scheduler media fallback skipped');return{videoUrl:null,imageUrl:null,extraImageUrl:null,imageSourceLabel:'lifestyle text-only'};}\n  const videos=Array.isArray(result?.sourceVideos)?result.sourceVideos.filter(Boolean):[];";

  if (!src.includes(marker)) {
    throw new Error('[LIFESTYLE TEXT ONLY PATCH] scheduler chooseSourceMedia marker not found');
  }
  return src.replace(marker, replacement);
}

fs.readFileSync = function patchedReadFileSync(filename, ...args) {
  const data = originalReadFileSync(filename, ...args);
  if (!schedulerPatched && path.resolve(String(filename)) === schedulerTarget) {
    const isBuffer = Buffer.isBuffer(data);
    const src = isBuffer ? data.toString('utf8') : String(data);
    const transformed = transformSchedulerSource(src);
    schedulerPatched = true;
    fs.readFileSync = originalReadFileSync;
    console.log('[Autopilot][LIFESTYLE TEXT ONLY PATCH] scheduler fallback guard applied');
    return isBuffer ? Buffer.from(transformed, 'utf8') : transformed;
  }
  return data;
};

console.log('[Autopilot][LIFESTYLE TEXT ONLY PATCH] lifestyle posts forced to text-only');
