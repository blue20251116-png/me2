'use strict';
// Which kind of post (product / recipe / lifestyle) each account makes next, and special-story detection.
const { db } = require('../infra/db');
const { clean } = require('./aiCalls');

const CONTENT_MODE_SEQUENCE = [
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
  { mode: 'product', specialStory: false },
  { mode: 'recipe', specialStory: false },
];

const contentModeCursor = new Map();

function persistentContentSeed(accountId) {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE account_id=?').get(accountId);
    return Number(row?.c || 0) % CONTENT_MODE_SEQUENCE.length;
  } catch (e) {
    console.warn('[AutopilotV3][CONTENT MIX SEED] DB seed 실패 → account seed 사용 ' + e.message);
    return Math.abs(Number(accountId) || 0) % CONTENT_MODE_SEQUENCE.length;
  }
}

function currentContentCursor(accountId) {
  if (!contentModeCursor.has(accountId)) {
    const seed = persistentContentSeed(accountId);
    contentModeCursor.set(accountId, seed);
    console.log(
      '[AutopilotV3][CONTENT MIX SEED] account=' +
        accountId +
        ' persistentSlot=' +
        seed +
        '/' +
        CONTENT_MODE_SEQUENCE.length
    );
  }
  return Number(contentModeCursor.get(accountId) || 0) % CONTENT_MODE_SEQUENCE.length;
}

function preferredContentSlot(accountId) {
  return CONTENT_MODE_SEQUENCE[currentContentCursor(accountId)];
}

function advanceContentMode(accountId) {
  contentModeCursor.set(accountId, (currentContentCursor(accountId) + 1) % CONTENT_MODE_SEQUENCE.length);
}

function specialStorySignals(v) {
  const t = clean(v);
  if (!t) return 0;
  let s = 0;
  for (const r of [
    /(고체|젤형|캡슐|스틱|패치|롤온)/i,
    /(자동|센서|감지|무선|진공|압축)/i,
    /(접이|폴딩|회전|자석|마그넷|걸이|틈새|슬라이드)/i,
    /(미니|휴대|포켓|벽걸이|부착|클립)/i,
    /(전용|일체형|분리형|다기능)/i,
  ])
    if (r.test(t)) s++;
  return s;
}

function specialStoryScore(material, analysis, vision) {
  const evidence = [
    analysis?.topic,
    analysis?.secretTerm,
    ...(analysis?.searchTerms || []),
    vision?.soldObject,
    vision?.evidence,
    material?.sourceText,
    material?.authorReplies,
  ]
    .filter(Boolean)
    .join(' ');
  let s = specialStorySignals(evidence);
  if (
    /(냄새|악취|얼룩|물때|곰팡|먼지|정리|수납|젖|습기|빨래|청소|신발|화장실|욕실|주방|차량|침대|옷장|냉장고|반려|집들이)/i.test(
      evidence
    )
  )
    s += 1;
  if (/(뭐지|신기|처음|이런 게|특이|놀|ㅋㅋ|;;|ㅠㅠ)/i.test(evidence)) s += 1;
  return s;
}

function isSpecialStoryCandidate(material, analysis, vision) {
  return specialStoryScore(material, analysis, vision) >= 2;
}

function localStrongContentMode(material) {
  const t = String(
    (material?.sourceText || material?.text || '') + '\n' + (material?.authorReplies || '')
  ).toLowerCase();
  if (!t.trim()) return null;
  const recipeSignals = [
    /레시피/,
    /재료/,
    /만드는\s*법/,
    /큰술|작은술|스푼|\d+\s*(?:g|ml|그램)/i,
    /볶(?:아|기|음)|굽(?:고|기)|끓(?:여|이|기)|에어프라이어|오븐|프라이팬|팬에/i,
    /간장|고추장|된장|다진\s*마늘|설탕|식초|참기름|들기름/i,
  ];
  let hits = 0;
  for (const re of recipeSignals) if (re.test(t)) hits++;
  if (hits >= 2) return 'recipe';
  return null;
}

module.exports = {
  preferredContentSlot,
  advanceContentMode,
  specialStoryScore,
  isSpecialStoryCandidate,
  localStrongContentMode,
};
