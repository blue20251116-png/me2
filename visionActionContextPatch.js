const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function visionActionContextLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');
  let changed = 0;

  source = source.replace(
    'JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","searchTerms":[""],"confidence":0,"evidence":""}',
    '이미지에서 단순히 물건 이름만 찾지 말고 실제 사람이 무엇을 하고 있는지 반드시 확인한다. 특히 상품의 원래 용도와 다른 활용법, 조리/청소/수납/손질 같은 행동이 보이면 actualAction에 구체적으로 적고, 그 장면이 왜 눈에 띄는지 mainHook에 적는다. useContext는 kitchen|cleaning|storage|beauty|food|daily|other 중 하나로 쓴다. unusualUse는 일반적인 용도와 다른 활용이면 true다. 이미지에서 확인되지 않은 향, 맛, 성능, 사용감, 효과를 추측하지 않는다. JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","actualAction":"","useContext":"other","unusualUse":false,"mainHook":"","searchTerms":[""],"confidence":0,"evidence":""}'
  );
  if (source.includes('"actualAction":""')) changed++;

  source = source.replace(
    "soldObject:clean(d?.soldObject),dish:clean(d?.dish),promotedIngredient:clean(d?.promotedIngredient),",
    "soldObject:clean(d?.soldObject),dish:clean(d?.dish),promotedIngredient:clean(d?.promotedIngredient),actualAction:clean(d?.actualAction).slice(0,240),useContext:clean(d?.useContext||'other').slice(0,40),unusualUse:d?.unusualUse===true,mainHook:clean(d?.mainHook).slice(0,180),"
  );
  if (source.includes('actualAction:clean(d?.actualAction)')) changed++;

  source = source.replace(
    "console.log(`[AutopilotV3][VISION TARGET] kind=${result.kind} sold=\"${result.soldObject||'-'}\" dish=\"${result.dish||'-'}\" ingredient=\"${result.promotedIngredient||'-'}\" confidence=${result.confidence} terms=\"${result.searchTerms.join(' / ')}\"`);",
    "console.log(`[AutopilotV3][VISION TARGET] kind=${result.kind} sold=\"${result.soldObject||'-'}\" action=\"${result.actualAction||'-'}\" hook=\"${result.mainHook||'-'}\" unusual=${result.unusualUse?'yes':'no'} confidence=${result.confidence} terms=\"${result.searchTerms.join(' / ')}\"`);"
  );

  source = source.replace(
    "return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',searchTerms:[],confidence:0,evidence:''};",
    "return{kind:'product',soldObject:'',dish:'',promotedIngredient:'',actualAction:'',useContext:'other',unusualUse:false,mainHook:'',searchTerms:[],confidence:0,evidence:''};"
  );

  source = source.replace(
    "[판매대상 검수]\\n${visionText}`,
",
    "[판매대상 검수]\\n${visionText}\\n\\n[시각 행동 절대규칙]\\n판매대상 검수에 actualAction/mainHook이 있으면 그 실제 행동과 장면을 글의 중심 사실로 사용한다. unusualUse=true면 제품 일반후기보다 그 의외의 활용법을 우선한다. 시각자료에서 확인되지 않은 향/맛/성능/효과/사용감을 임의로 추가하지 않는다. 예: 치실로 사과 껍질을 벗기는 장면이면 치실의 민트향 후기가 아니라 치실로 사과를 깎는 행동을 소재로 쓴다.`,
"
  );
  if (source.includes('[시각 행동 절대규칙]')) changed++;

  if (changed < 3) {
    console.error(`[AutopilotV3][VISION ACTION] PATCH INCOMPLETE changed=${changed}/3`);
    throw new Error('VISION_ACTION_CONTEXT_PATCH_INCOMPLETE');
  }

  console.log('[AutopilotV3][VISION ACTION] existing Vision 1회에 actualAction/mainHook 추가 · 추가 Vision 호출 없음');
  mod._compile(source, filename);
};

console.log('[AutopilotV3][VISION ACTION] patch armed');
