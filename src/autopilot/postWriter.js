'use strict';
// Writing the Threads body and comment lead in the persona voice, recipe comment repair, secret-ingredient scrubbing.
const { normalizeVoice, voiceGuide, formatVoice, assertVoice, reviewSourceVoice } = require('../content/voicePolicy');
const { pickPersona } = require('../content/personas');
const { personaScores } = require('../content/personaStats');
const { callAiText, clean } = require('./aiCalls');

// Replaces the secret term only as a standalone word (not inside 소금물/마늘빵), remapping a trailing
// particle to fit the vowel-ending replacement (소금을 → 비밀 재료를).
const SCRUB_PARTICLE_ALT = '이랑|은|는|이|가|을|를|과|와|도|만|의|에|로|나|랑|야';

const SCRUB_PARTICLE_REMAP = { 을: '를', 이: '가', 은: '는', 과: '와', 이랑: '랑' };

// Body call sites pass '이거' (reads as natural hidden-identity prose); the comment's ingredient
// list uses the default '비밀 재료' placeholder.
function scrubSecret(text, secret, product, replacement = '비밀 재료') {
  let out = String(text || '').trim();
  for (const v of [secret, product]) {
    const t = clean(v);
    if (t.length < 2) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![가-힣])${escaped}(${SCRUB_PARTICLE_ALT})?(?=[^가-힣]|$)`, 'g');
    out = out.replace(re, (m, particle) => replacement + (particle ? SCRUB_PARTICLE_REMAP[particle] || particle : ''));
  }
  return out;
}

// Recipe headings count only when the label stands alone on its own line (optional emoji/bullet and
// colon), so a sentence that merely mentions "재료" is not a heading and normalizing never glues the
// label onto the next line.
function hasIngredientHeading(text) {
  return /^[ \t]*(?:🥘|✅|▪|■)?[ \t]*재료[ \t]*[:：]?[ \t]*$/im.test(String(text || ''));
}

function hasMethodHeading(text) {
  return /^[ \t]*(?:🍳|✅|▪|■)?[ \t]*(?:만드는[ \t]*법|조리[ \t]*방법|만들기)[ \t]*[:：]?[ \t]*$/im.test(
    String(text || '')
  );
}

// The model often writes a heading with its content on the same line ("🥘 재료: 계란 2개, 햄"),
// in markdown ("**재료**", "[만드는 법]") or with a serving note ("재료 (2인분)"). Those used to fail
// the standalone-heading check and the post was discarded (production 2026-10-01: ~9 of 45 sources),
// so they are rewritten into the canonical form with the content moved to the next line. A sentence
// that merely starts with the word ("재료 진짜 신선함") still does not count: after the label only a
// colon (+ content) or nothing may follow.
const HEADING_OPEN = '[ \\t]*(?:🥘|🍳|✅|▪|■|[-•*#]+)?[ \\t]*(?:\\*\\*|\\[|【)?[ \\t]*';
const HEADING_CLOSE = '[ \\t]*(?:\\([^)\\n]*\\))?[ \\t]*(?:\\*\\*|\\]|】)?[ \\t]*(?:[:：][ \\t]*(.*?))?[ \\t]*$';
const INGREDIENT_HEADING_LINE = new RegExp(`^${HEADING_OPEN}재료${HEADING_CLOSE}`, 'm');
const METHOD_HEADING_LINE = new RegExp(
  `^${HEADING_OPEN}(?:만드는[ \\t]*법|조리[ \\t]*방법|만들기)${HEADING_CLOSE}`,
  'm'
);

function normalizeRecipeHeadings(text) {
  let out = String(text || '').trim();
  out = out.replace(INGREDIENT_HEADING_LINE, (m, rest) => (rest ? `🥘 재료\n${rest}` : '🥘 재료'));
  out = out.replace(METHOD_HEADING_LINE, (m, rest) => (rest ? `🍳 만드는 법\n${rest}` : '🍳 만드는 법'));
  return out;
}

function normalizeThreadsLayout(text) {
  return formatVoice(text);
}

async function rewriteThreadsTone(accountId, text, { mode, material, comment = false, visualEvidence = '' }) {
  if (comment && !String(text || '').trim()) return '';
  return reviewSourceVoice(
    text,
    { mode, comment, sourceText: material?.sourceText, authorReplies: material?.authorReplies, visualEvidence },
    (system, user) => callAiText(accountId, system, user, { maxTokens: 1000, temperature: 0.15 })
  );
}

async function repairRecipeComment(accountId, { commentLead, material, analysis, productName }) {
  let fixed = normalizeRecipeHeadings(commentLead);
  if (hasIngredientHeading(fixed) && hasMethodHeading(fixed)) return fixed;
  try {
    const d = await callAiText(
      accountId,
      `레시피 댓글 포맷 교정기다. 기존 내용을 최대한 보존하면서 반드시 '🥘 재료' 섹션과 '🍳 만드는 법' 섹션을 둘 다 만든다. 실제로 따라할 수 있게 작성한다. 조리 단계는 짧고 자연스러운 반말로 쓴다. 음슴체와 존댓말은 금지한다. 쿠팡 상품명/브랜드명/정확한 비밀소스 이름은 쓰지 말고 핵심 제휴재료는 '비밀 소스' 또는 '비밀 재료'라고만 쓴다. 링크와 광고고지는 쓰지 않는다. JSON만 출력: {"commentLead":""}`,
      `[기존 댓글]\n${commentLead}\n\n[원문]\n${material.sourceText.slice(0, 3500)}\n\n내부 비밀재료:${analysis.secretTerm || productName}`,
      { maxTokens: 1800, temperature: 0.25 }
    );
    fixed = normalizeRecipeHeadings(String(d.commentLead || ''));
  } catch (e) {
    console.warn(`[AutopilotV3][RECIPE REPAIR] AI 교정 실패: ${e.message}`);
  }
  if (!hasIngredientHeading(fixed) || !hasMethodHeading(fixed))
    throw new Error('원문에 근거한 레시피 댓글을 완성하지 못했습니다');
  return fixed;
}

async function generatePost(accountId, { material, analysis, product, target }) {
  const productName = clean(product?.name);
  const personaText = [
    analysis.topic,
    analysis.vision?.soldObject,
    analysis.vision?.dish,
    material.sourceText,
    material.authorReplies,
  ]
    .filter(Boolean)
    .join(' ');
  const persona = pickPersona({ mode: analysis.mode, text: personaText, scores: personaScores(accountId) });
  console.log(`[AutopilotV3][PERSONA] picked="${persona.name}"(${persona.id}) mode=${analysis.mode}`);
  const d = await callAiText(
    accountId,
    `너는 한국 Threads에서 실제 사람이 쓰는 쇼핑/레시피 글 편집자다. 아래 문체 정책에 따라 원 소재를 가장 바이럴한 각도로 재구성한다.

${voiceGuide(persona.block)}

[레시피]
- 본문 text는 위 문체 정책대로 가장 강한 후킹 포인트를 중심으로 재구성한다. 다만 재료/조리법 같은 레시피 사실은 원문 근거를 벗어나지 않는다.
- 정확한 제휴 소스/핵심재료 이름은 본문에서 숨긴다.
- 본문에서 그 재료를 가리킬 때 '비밀 소스'/'비밀 재료' 같은 이름표를 쓰지 않는다. 정체를 밝히지 않으면서 넣었을 때의 효과·반응으로 자연스럽게 표현한다: "이거 하나만 넣으면 진짜 킥이야", "이거 넣었더니 완전 달라짐", "이거 없이는 이제 못 만들 듯" 처럼.
- 본문 마지막에 댓글 유도 문구를 자동으로 붙이지 않는다.
- commentLead는 반드시 '🥘 재료'와 '🍳 만드는 법' 두 섹션으로 쓴다.
- 조리 단계도 짧은 반말로 쓴다. 음슴체/존댓말 금지.
- commentLead의 재료 목록에서 그 재료 자리는 '비밀 소스' 또는 '비밀 재료'라고만 쓴다.

[일반상품/생활]
- 본문 text는 위 문체 정책대로 원문에서 가장 강한 포인트 하나를 중심으로 재구성한다. 확인되지 않은 사실은 새로 만들지 않는다.
- 상품명/스펙 나열, '✅ 핵심만', 링크, 광고고지는 본문에 쓰지 않는다.
- commentLead는 확인된 정보 하나를 자연스러운 반말 1~2문장으로 보충한다. 추가 정보가 없으면 빈 문자열로 둔다.

JSON만 출력:{"text":"본문","commentLead":"댓글"}`,
    `타겟:${target || '전체'}\n모드:${analysis.mode}\n주제:${analysis.topic}\n내부 전용 비밀재료(출력 금지):${analysis.secretTerm || productName}\n쿠팡 상품:${productName}\n판매대상:${analysis.vision?.soldObject || '-'} / 요리:${analysis.vision?.dish || '-'}\n[시각 근거]\n${analysis.vision?.evidence || '(없음)'}\n[Threads 원문]\n${material.sourceText.slice(0, 5000)}\n[작성자 추가댓글]\n${material.authorReplies.slice(0, 5000) || '(없음)'}`,
    { maxTokens: 2800, temperature: 0.65 }
  );
  let text = normalizeThreadsLayout(d.text || ''),
    commentLead = String(d.commentLead || '').trim();
  if (!text) throw new Error('Threads 소재 기반 본문 생성 결과가 비었습니다');
  if (analysis.mode === 'recipe') {
    text = scrubSecret(text, analysis.secretTerm, productName, '이거');
    commentLead = scrubSecret(commentLead, analysis.secretTerm, productName);
    if (/🥘\s*재료|🍳\s*만드는 법/.test(text))
      text = text.replace(/\n?(?:🥘\s*재료|🍳\s*만드는 법)[\s\S]*$/, '').trim();
    commentLead = await repairRecipeComment(accountId, { commentLead, material, analysis, productName });
  } else {
    if (/✅\s*핵심만/.test(text)) text = text.replace(/\n?✅\s*핵심만[\s\S]*$/, '').trim();
    commentLead = normalizeVoice(commentLead.replace(/^\s*✅?\s*핵심만\s*[:：]?\s*\n?/i, ''));
    text = text
      .replace(/\{\{COUPANG_LINK\}\}/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  text = await rewriteThreadsTone(accountId, text, {
    mode: analysis.mode,
    topic: analysis.topic,
    material,
    visualEvidence: analysis.vision?.evidence,
  });
  if (analysis.mode !== 'recipe' && commentLead) {
    try {
      commentLead = await rewriteThreadsTone(accountId, commentLead, {
        mode: analysis.mode,
        topic: analysis.topic,
        material,
        comment: true,
        visualEvidence: analysis.vision?.evidence,
      });
    } catch (e) {
      if (e.code !== 'CONTENT_STYLE_REJECTED') throw e;
      commentLead = '';
    }
  }
  if (analysis.mode === 'recipe') text = scrubSecret(text, analysis.secretTerm, productName, '이거');
  text = assertVoice(text, { mode: analysis.mode });
  console.log(`[AutopilotV3][SOURCE VOICE v2] text="${text.replace(/\n/g, ' / ')}"`);
  return { text, commentLead, persona: persona.id };
}

module.exports = { scrubSecret, hasIngredientHeading, hasMethodHeading, normalizeRecipeHeadings, generatePost };
