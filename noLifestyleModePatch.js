const fs = require('fs');
const path = require('path');

const target = path.resolve(path.join(__dirname, 'autopilotMaterialEngine.js'));
const previousReadFileSync = fs.readFileSync.bind(fs);
let applied = false;

function transformSource(src) {
  let out = String(src);

  // contentMixPatch가 만든 10% lifestyle 슬롯을 완전히 제거한다.
  out = out
    .replace("  {mode:'lifestyle',specialStory:false},\n  {mode:'lifestyle',specialStory:true}\n", "  {mode:'product',specialStory:false},\n  {mode:'recipe',specialStory:false}\n")
    .replace("target=45/45/10", "target=50/50/0")
    .replace("sourcePreserve=90% lifestyle=10%", "sourceVoice=v2 lifestyle=0%");

  // lifestyle 소재를 product로 위장시키지 않는다.
  // 분석 결과가 lifestyle이면 해당 후보를 소비/발행하지 않고 다음 소재로 넘긴다.
  const analysisNeedle = "      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 후보 소모 없이 발행 시도`);";
  const analysisReplacement = "      if(analysis.mode==='lifestyle'){console.log(`[AutopilotV3][NO LIFESTYLE SKIP] @${material.username||'-'} lifestyle 소재 → 발행 제외 · 다음 후보`);continue;}\n" + analysisNeedle;
  if (!out.includes(analysisNeedle)) {
    throw new Error('[NO LIFESTYLE PATCH] analysis marker not found');
  }
  out = out.replace(analysisNeedle, analysisReplacement);

  return out;
}

fs.readFileSync = function patchedReadFileSync(file, ...args) {
  const resolved = path.resolve(String(file));
  const data = previousReadFileSync(file, ...args);
  if (resolved !== target) return data;

  const isBuffer = Buffer.isBuffer(data);
  const src = isBuffer ? data.toString('utf8') : String(data);
  const transformed = transformSource(src);

  if (!applied) {
    applied = true;
    console.log('[NO LIFESTYLE PATCH] ON · lifestyle=SKIP · product/recipe only');
  }

  return isBuffer ? Buffer.from(transformed, 'utf8') : transformed;
};

