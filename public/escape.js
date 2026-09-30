'use strict';
// Shared by every page that builds HTML strings: escape anything that did not come from our own
// constants, and only let http(s) URLs into href/src.
window.escapeHtml = function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
window.safeUrl = function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:' || url.protocol === 'data:'
      ? url.href
      : '';
  } catch {
    return '';
  }
};
