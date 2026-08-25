'use strict';

const fs = require('fs');
const path = require('path');

const target = path.resolve(path.join(__dirname, 'autopilotMaterialEngine.js'));
const previousReadFileSync = fs.readFileSync.bind(fs);
let applied = false;

function transformSource(src) {
  const buildMarker = 'async function buildThreadsFirstAutopilot(accountId,{target}){';
  if (!src.includes(buildMarker)) {
    console.warn('[Autopilot][LOCAL PREFILTER] build marker not found');
    return src;
  }

  const helper = `function localStrongContentMode(material){
  const t=String((material?.sourceText||material?.text||'')+'\\n'+(material?.authorReplies||'')).toLowerCase();
  if(!t.trim())return null;
  const recipeSignals=[/레시피/,/재료/,/만드는\\s*법/,/큰술|작은술|스푼|\\d+\\s*(?:g|ml|그램)/i,/볶(?:아|기|음)|굽(?:고|기)|끓(?:여|이|기)|에어프라이어|오븐|프라이팬|팬에/i,/간장|고추장|된장|다진\\s*마늘|설탕|식초|참기름|들기름/i];
  let hits=0;for(const re of recipeSignals)if(re.test(t))hits++;
  if(hits>=2)return 'recipe';
  return null;
}
`;
  src = src.replace(buildMarker, helper + buildMarker);

  const visionMarker = '      const vision=await identifyCommerceTarget(accountId,material);';
  const visionInsert = `      const localMode=localStrongContentMode(material);
      if(localMode&&localMode!==preferredMode){
        console.log(\`[AutopilotV3][LOCAL PREFILTER DEFER] preferred=\${preferredMode} local=\${localMode} @\${material.username||'-'} → 후보 유지 · Vision/실제 판정 계속\`);
      }
      const vision=await identifyCommerceTarget(accountId,material);`;
  if (!src.includes(visionMarker)) {
    console.warn('[Autopilot][LOCAL PREFILTER] vision marker not found');
    return src;
  }
  src = src.replace(visionMarker, visionInsert);
  return src;
}

fs.readFileSync = function localPrefilterRead(filename, ...args) {
  const data = previousReadFileSync(filename, ...args);
  if (!applied && path.resolve(String(filename)) === target) {
    const isBuffer = Buffer.isBuffer(data);
    const src = isBuffer ? data.toString('utf8') : String(data);
    const transformed = transformSource(src);
    applied = true;
    fs.readFileSync = previousReadFileSync;
    console.log('[Autopilot][LOCAL PREFILTER] 후보3개 유지 · 로컬 mode 불일치여도 Vision/실제 판정 계속 · exact identity untouched');
    return isBuffer ? Buffer.from(transformed, 'utf8') : transformed;
  }
  return data;
};

console.log('[Autopilot][LOCAL PREFILTER] source hook armed · no early candidate drop');
