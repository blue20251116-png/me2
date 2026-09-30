'use strict';
// Final text clean-up applied to every body/comment right before it is sent to Threads (also to
// posts that were queued long ago, so older rows get the same treatment).

// Removes a dash (—, –, or the Hangul ㅡ) used as a standalone separator ("좋음 ㅡ 진짜"), which real
// casual posts don't use (models copy it from the prompt's own formatting). A dash attached to a
// word ("이거ㅡㅡ") is the "-_-" emoticon and is kept.
function stripStrayDashArtifacts(text) {
  return String(text || '')
    .split('\n')
    .map(line => {
      if (/[—–ㅡ]/.test(line) && /^[\s—–ㅡ]+$/.test(line)) return '';
      return line
        .replace(/\s+[—–ㅡ]+\s+/g, ' ')
        .replace(/^[—–ㅡ]+\s+/, '')
        .replace(/\s+[—–ㅡ]+$/, '');
    })
    .join('\n');
}
// Pictograph emoji are banned in posts (they hurt reach); text reactions like ㅋㅋ/ㄷㄷ/ㅠㅠ/;; stay.
function stripEmoji(text) {
  // Also strips the emoji variation selector and zero-width joiner that multi-part emoji leave behind.
  return String(text || '')
    .split('\n')
    .map(line =>
      line
        .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    )
    .join('\n');
}
// Order matters: (1) trim ., ; glued to the end of URLs (would break the link), (2) drop formal
// sentence-final periods, including when a reaction follows directly ("대박.ㅋㅋ"), while keeping
// decimals (1.5) and ellipses (...), (3) strip emoji last, since step 2 needs to see "대박.😊".
function sanitizePublishedThreadsText(value) {
  return stripEmoji(
    stripStrayDashArtifacts(String(value || ''))
      .replace(/https?:\/\/\S+/gi, m => m.replace(/[.,;]+$/, ''))
      .replace(/(^|[^.\d])\.(?!\.)(?=\s|$|\p{Extended_Pictographic}|[ㅋㅎㅜㅠㄷ~!?;])/gu, '$1')
  )
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Threads may turn the first URL of a text reply into a link-preview card. When the affiliate
// comment has exactly one URL, append the same URL with a #fragment (same destination - fragments
// are never sent to the server) so the reply carries two URLs. Any domain: some accounts post a
// plain www.coupang.com URL instead of a link.coupang.com deeplink.
function applyCoupangReplyPreviewGuard(value) {
  const text = sanitizePublishedThreadsText(value);
  const matches = [...text.matchAll(/https?:\/\/\S+/gi)];
  if (matches.length !== 1) return { text, guardApplied: false, urlCount: matches.length };

  const original = matches[0][0];
  const alternate = original.includes('#') ? `${original}preview2` : `${original}#preview2`;
  return {
    text: `${text}\n${alternate}`.trim(),
    guardApplied: true,
    urlCount: 2,
  };
}

// Moves the Coupang Partners disclosure line to the top of the comment.
function ensureCoupangDisclosureFirst(text) {
  const raw = String(text || '')
    .replace(/\r/g, '')
    .trim();
  if (!raw) return raw;
  const lines = raw.split('\n');
  const disclosureIndex = lines.findIndex(line => /쿠팡\s*파트너스\s*활동의\s*일환/i.test(line));
  if (disclosureIndex < 0) return raw;
  const disclosure = lines[disclosureIndex].trim();
  const rest = lines
    .filter((_, index) => index !== disclosureIndex)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return rest ? `${disclosure}\n\n${rest}` : disclosure;
}

module.exports = {
  stripStrayDashArtifacts,
  stripEmoji,
  sanitizePublishedThreadsText,
  applyCoupangReplyPreviewGuard,
  ensureCoupangDisclosureFirst,
};
