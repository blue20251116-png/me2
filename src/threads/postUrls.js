'use strict';
// Pure helpers shared by the scraper (worker) and the collector (main process).

function canonicalPostUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    u.pathname = u.pathname.replace(/\/media\/?$/i, '').replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw || '')
      .split(/[?#]/)[0]
      .replace(/\/media\/?$/i, '');
  }
}
function isHttpVideoUrl(value) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(s)) return true;
  if (/fbcdn|cdninstagram|threads|instagram/i.test(s) && /video|mp4|bytestart|byteend|range=/i.test(s)) return true;
  return false;
}
const TEXT_READ_FAILURE = /Threads 원문 텍스트를 읽지 못했습니다/i;
function isTextReadFailure(err) {
  return TEXT_READ_FAILURE.test(String(err?.message || ''));
}

module.exports = { canonicalPostUrl, isHttpVideoUrl, isTextReadFailure };
