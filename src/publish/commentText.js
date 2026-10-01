'use strict';
// Builds the follow-up comment posted under each published post: the recipe/detail text plus the
// Coupang link and the legally required affiliate disclosure, within Threads' length limit.

function hasCoupangKeys(a) {
  return !!(String(a?.coupang_access_key || '').trim() && String(a?.coupang_secret_key || '').trim());
}
function isCoupangLink(link) {
  return /(^|\.)coupang\.com|link\.coupang\.com/i.test(String(link || ''));
}
const DEFAULT_COUPANG_DISCLOSURE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
function cleanCommentLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}
function compactRecipePrefix(prefix, limit) {
  const cap = Math.max(0, Number(limit) || 0);
  if (!cap) return '';
  const raw = String(prefix || '')
    .replace(/\r/g, '')
    .trim();
  if (!raw) return '';
  if (raw.length <= cap) return raw;
  const lines = raw.split('\n').map(cleanCommentLine).filter(Boolean);
  const ingredientIdx = lines.findIndex(x => /재료/.test(x));
  const methodIdx = lines.findIndex(x => /(만드는\s*법|조리\s*법|만들기)/.test(x));
  const isRecipe = ingredientIdx >= 0 || methodIdx >= 0;
  if (!isRecipe) {
    const out = [];
    let used = 0;
    for (const line of lines) {
      const add = (out.length ? 1 : 0) + line.length;
      if (used + add > cap) break;
      out.push(line);
      used += add;
    }
    return out.join('\n');
  }
  const ingredientHeader = '🥘 재료';
  const methodHeader = '🍳 만드는 법';
  let ingredients = [];
  let methods = [];
  const ingStart = ingredientIdx >= 0 ? ingredientIdx + 1 : 0;
  const ingEnd = methodIdx > ingStart ? methodIdx : lines.length;
  for (const line of lines.slice(ingStart, ingEnd)) {
    const cleaned = line.replace(/^[▪•·\-–—*✅\s]+/, '').trim();
    if (cleaned && !/^(재료|만드는\s*법|조리\s*법)$/i.test(cleaned)) ingredients.push(cleaned);
  }
  if (methodIdx >= 0) {
    for (const line of lines.slice(methodIdx + 1)) {
      const cleaned = line
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/^[▪•·\-–—*✅\s]+/, '')
        .trim();
      if (cleaned) methods.push(cleaned);
    }
  }
  if (!ingredients.length && ingredientIdx >= 0) {
    const inline = lines[ingredientIdx].replace(/^.*?재료\s*[:：]?\s*/, '').trim();
    if (inline) ingredients = [inline];
  }
  if (!methods.length && methodIdx >= 0) {
    const inline = lines[methodIdx].replace(/^.*?(?:만드는\s*법|조리\s*법|만들기)\s*[:：]?\s*/, '').trim();
    if (inline) methods = [inline];
  }
  const render = (ings, steps) => {
    const a = ings.length ? `${ingredientHeader}\n${ings.join(', ')}` : '';
    const b = steps.length ? `${methodHeader}\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '';
    return [a, b].filter(Boolean).join('\n\n');
  };
  let ing = ingredients.slice(0, 8),
    steps = methods.slice(0, 4),
    out = render(ing, steps);
  while (out.length > cap && steps.length > 1) {
    steps.pop();
    out = render(ing, steps);
  }
  while (out.length > cap && ing.length > 3) {
    ing.pop();
    out = render(ing, steps);
  }
  if (out.length <= cap && ing.length && steps.length) return out;
  const minIng = ingredients.slice(0, 3);
  const minSteps = methods.slice(0, 1);
  out = render(minIng, minSteps);
  if (out.length <= cap && minIng.length && minSteps.length) return out;
  const safe = [];
  let used = 0;
  for (const line of lines) {
    const add = (safe.length ? 1 : 0) + line.length;
    if (used + add > cap) break;
    safe.push(line);
    used += add;
  }
  return safe.join('\n');
}
function extractFirstHttpUrl(value) {
  const m = String(value || '').match(/https?:\/\/[^\s<>'\"\])}]+/i);
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}
function sanitizeCommentPrefix(value) {
  const raw = String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!raw) return '';
  const isRecipe = /(🥘|🍳|재료|만드는\s*법|조리\s*법)/i.test(raw);
  if (isRecipe) return raw.replace(/^\s*✅?\s*핵심만\s*[:：]?\s*\n?/i, '').trim();
  const lines = raw
    .split('\n')
    .map(x =>
      x
        .replace(/^\s*(?:✅\s*)?(?:핵심만\s*[:：]?\s*)?/i, '')
        .replace(/^\s*[-▪•·*]+\s*/, '')
        .trim()
    )
    .filter(Boolean);
  const clean = [];
  for (const line of lines) {
    if (!clean.includes(line)) clean.push(line);
  }
  return clean.join('\n').trim();
}
// The affiliate comment: optional prefix (recipe/notes), the link once, then the disclosure.
// threadsApi.publishReply strips the link's scheme so Threads shows no preview card.
function buildLinkComment(account, prefix, link, maxLength = 450) {
  const cap = Math.min(450, Math.max(1, Number(maxLength) || 450));
  const l = extractFirstHttpUrl(link);
  if (!l) throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');
  const disclosure = isCoupangLink(l) ? DEFAULT_COUPANG_DISCLOSURE : '';
  const tail = [l, disclosure].filter(Boolean).join('\n\n');
  if (tail.length > cap) throw new Error('쿠팡 링크 자체가 너무 길어 댓글을 만들 수 없습니다: ' + tail.length + '자');
  const available = Math.max(0, cap - tail.length - 2);
  const safePrefix = sanitizeCommentPrefix(prefix);
  const head = compactRecipePrefix(safePrefix, available);
  const comment = [head, tail].filter(Boolean).join('\n\n');
  if (comment.length > cap) throw new Error('댓글 길이 조립 오류: ' + comment.length + '/' + cap + '자');
  return comment;
}

async function buildCommentText(account, post) {
  if (hasCoupangKeys(account) && post.recipe_comment_text && !post.link)
    throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');
  if (!post.link) return compactRecipePrefix(sanitizeCommentPrefix(post.recipe_comment_text || ''), 450);
  return buildLinkComment(account, post.recipe_comment_text || '', post.link, 450);
}

module.exports = {
  hasCoupangKeys,
  isCoupangLink,
  buildLinkComment,
  buildCommentText,
  DEFAULT_COUPANG_DISCLOSURE,
};
