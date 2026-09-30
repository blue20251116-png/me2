'use strict';
// Final text clean-up applied to every body/comment right before it is sent to Threads.

// Threads 본문은 발행 직전에 한 번 더 정리한다
// 이미 DB에 저장된 예약글/대기글도 이 단계를 지나므로 생성 시점이 오래됐어도 마침표가 제거된다
// 숫자 소수점(1.5)처럼 숫자 사이의 점은 보존하고, 말줄임(...)도 온전히 보존한다 —
// 예전 정규식은 전역 매치가 소비한 문자를 다시 조건절로 쓰면서 말줄임 맨 끝 점 하나를 갉아먹었다
// (예: "완전 신기함..." → "완전 신기함.."), voiceGuide()가 명시적으로 허용하는 말줄임 표현과 충돌했다.
// REGRESSION (found via synthetic testing): 아래 문장 종결 마침표 제거 규칙은 소수점(1.5) 보호를
// 위해 "숫자 뒤 마침표"는 건드리지 않는데, 링크가 숫자로 끝나는 경우가 흔해서
// ("...보러가기 https://link.coupang.com/a/abc123.") 그 마침표가 그대로 URL 끝에 들러붙어
// 실제 클릭 링크(https://.../abc123.)가 깨진 채로 발행되는 부작용이 있었다. applyCoupangReplyPreviewGuard가
// 이 텍스트에서 URL을 다시 정규식으로 뽑아 쓰기 때문에, 마침표 제거보다 먼저 모든 URL의 끝에 붙은
// .,; 를 떼어낸다 (scheduler.js의 extractFirstHttpUrl이 이미 쓰는 것과 같은 방식).
// REGRESSION (found via synthetic testing, hourly review, 2026-09-13): the sentence-final-period
// strip below required whitespace or end-of-string right after the period, but real casual Korean
// social posts very often tack a reaction straight onto the period with no space at all
// ("실화냐.ㅋㅋ", "대박.😂") - exactly the "완벽하게 다듬어진 문어체" formal-period artifact this
// whole function exists to remove, silently left untouched because of what followed it rather than
// what preceded it. Widened the lookahead to also accept an emoji or a run of casual
// laughing/crying jamo/punctuation right after the period, without touching the decimal-point
// protection (still governed by the unrelated prefix check just before the period).
// REGRESSION (found via synthetic testing, hourly review, 2026-09-13): voiceGuide() itself
// explicitly names "ㅋㅋ, ㄷㄷ, ㅠㅠ, ;;" as the sanctioned casual reaction markers, but this
// lookahead's jamo/punctuation class only ever covered ㅋㅎㅜㅠ~!? - "ㄷ" (ㄷㄷ, a very common
// "shocked" reaction in this bot's persona voice) and ";" (;;) were both missing, so "실화냐.ㄷㄷ"
// and "대박.;;" kept the exact formal-period artifact this function exists to strip while the
// otherwise-identical "실화냐.ㅋㅋ" was already handled correctly.
// REGRESSION (found live, 2026-09-15): a real published post included a bare "ㅡ" used as a
// stray dash/separator ("이거 완전 신기함 ㅡ 진짜 대박임"), which voiceGuide() never sanctions as a
// reaction marker (only "ㅋㅋ, ㄷㄷ, ㅠㅠ, ;;" are) and which never appears anywhere in real casual
// Threads writing this bot is meant to imitate. The likely source is voiceGuide() itself: the
// prompt's own instructional text is full of em dashes ("—") as a meta-formatting device (see the
// REGRESSION comments throughout this file's neighbor voicePolicy.js), and a model can
// imitate that punctuation style back into its actual output, surfacing as "—"/"–"/the Hangul
// "ㅡ" (the same keystroke Korean users reach for as a quick dash substitute). Only strips a dash
// run used as a standalone token (bounded by whitespace or line start/end) - "이거ㅡㅡ웃김" with the
// dash directly attached to a word (the genuine "-_-" unimpressed-face emoticon shape) is left
// untouched, same principle as how ㅋㅋ/ㄷㄷ attach directly with no space.
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
// REGRESSION (found live, 2026-09-23): a real published post still included a pictograph emoji
// ("쿠션감이 장난 아님...\n😭 구름 위를...") despite voiceGuide() explicitly banning emoji everywhere
// (2026-09-21) - that ban was only ever a prompt instruction with no code-side enforcement, the
// same gap the "ㅡ" dash fix above already closed for a different unwanted character. Stripped
// here unconditionally (unlike the dash, no legitimate attached-emoticon exception applies to
// real pictograph emoji - ㅋㅋ/ㄷㄷ/ㅠㅠ/;; text reactions are untouched since they aren't
// Extended_Pictographic). Runs AFTER the period-before-emoji cleanup above, which still needs the
// emoji present to match its lookahead ("대박.😊" -> "대박😊" -> "대박" here) - stripping emoji
// first would leave that stray period behind uncaught.
function stripEmoji(text) {
  // ️ (emoji variation selector) and ‍ (ZWJ, glues multi-part emoji like 🌤️/👨‍👩‍👧
  // together) are not themselves Extended_Pictographic - stripping only the base pictograph and
  // leaving these behind left an orphaned invisible-ish artifact character.
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
function sanitizePublishedThreadsText(value) {
  return stripEmoji(
    stripStrayDashArtifacts(String(value || ''))
      .replace(/https?:\/\/\S+/gi, m => m.replace(/[.,;]+$/, ''))
      .replace(/(^|[^.\d])\.(?!\.)(?=\s|$|\p{Extended_Pictographic}|[ㅋㅎㅜㅠㄷ~!?;])/gu, '$1')
  )
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Threads는 TEXT 댓글의 첫 URL을 자동으로 링크 카드로 잡는 경우가 있다
// Coupang 댓글에 URL이 하나뿐이면 같은 목적지의 두 번째 URL을 fragment 변형으로 추가해
// "URL 2개" 형태로 발행한다. fragment는 서버 요청에 전달되지 않으므로 목적지는 동일하다
// 이 처리는 댓글에만 적용하며 일반 본문은 건드리지 않는다
// 예전에는 link.coupang.com 도메인만 매칭했는데, scheduler.js의 makeAffiliateLink()는 계정에
// 쿠팡 파트너스 API 자격증명이 없거나(createDeeplink가 원본 URL을 그대로 passthrough) URL이 이미
// "제휴 링크"로 분류되면(classifyCoupangUrl의 lptag/subid/aff 쿼리 휴리스틱) link.coupang.com이
// 아닌 일반 www.coupang.com 상품 URL을 댓글에 그대로 쓴다 - 그런 경우 이 정규식이 전혀 매칭하지
// 않아서 프리뷰 억제 자체가 조용히 스킵되고 있었다. 댓글에는 항상 이 링크 하나만 있으므로 도메인을
// 가리지 않고 어떤 URL이든 매칭한다.
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
