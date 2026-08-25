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
    .replace("sourcePreserve=90% lifestyle=10%", "sourcePreserve=100% lifestyle=0%");

  // lifestyle 소재를 product로 위장시키지 않는다.
  // 분석 결과가 lifestyle이면 해당 후보를 소비/발행하지 않고 다음 소재로 넘긴다.
  const analysisNeedle = "      if(analysis.mode!==preferredMode)console.log(`[AutopilotV3][CONTENT MIX SOFT FALLBACK] preferred=${preferredMode} got=${analysis.mode} → 후보 소모 없이 발행 시도`);";
  const analysisReplacement = "      if(analysis.mode==='lifestyle'){console.log(`[AutopilotV3][NO LIFESTYLE SKIP] @${material.username||'-'} lifestyle 소재 → 발행 제외 · 다음 후보`);continue;}\n" + analysisNeedle;
  if (!out.includes(analysisNeedle)) {
    throw new Error('[NO LIFESTYLE PATCH] analysis marker not found');
  }
  out = out.replace(analysisNeedle, analysisReplacement);

  // 프롬프트에서도 새 일상글 창작/강제 변환을 허용하지 않는다.
  out = out
    .replace("- lifestyle 슬롯일 때만 새 일상글을 작성할 수 있다.\\n", "- 새 일상글을 창작하지 않는다. 모든 발행은 수집된 원 Threads의 product 또는 recipe 소재만 사용한다.\\n")
    .replace("- analysis.mode가 lifestyle일 때만 새 일상글을 작성한다. lifestyle은 전체 발행의 10% 슬롯에서만 선택된다.\\n- lifestyle에서는 상품 홍보를 앞세우지 않고 사람의 상황·관찰·생각이 중심이 되게 쓴다.\\n- analysis.specialStory가 true인 lifestyle만 특수상품 일상썰 구조를 사용할 수 있다. 확인되지 않은 구체적 인물·구매·사용 사실은 만들지 않는다.\\n", "- lifestyle 모드는 발행하지 않는다. lifestyle로 판정된 소재는 다음 후보로 넘긴다.\\n");

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
