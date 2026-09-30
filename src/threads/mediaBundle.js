'use strict';
// A post with 2+ media items stores them in posts.image_url as one encoded "bundle" string;
// threadsApi.publishPost decodes it into a carousel. Up to 10 unique IMAGE/VIDEO items.
const MEDIA_BUNDLE_PREFIX = '__THREADS_MEDIA_BUNDLE__';

function normalizeMediaItems(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const type = String(item?.type || '').toUpperCase();
    const url = String(item?.url || '').trim();
    if (!url || !['IMAGE', 'VIDEO'].includes(type)) continue;
    if (!out.some(x => x.type === type && x.url === url)) out.push({ type, url });
    if (out.length >= 10) break;
  }
  return out;
}

function encodeMediaBundle(items) {
  const normalized = normalizeMediaItems(items);
  return normalized.length ? `${MEDIA_BUNDLE_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}` : null;
}

function decodeMediaBundle(value) {
  const s = String(value || '');
  if (!s.startsWith(MEDIA_BUNDLE_PREFIX)) return null;
  try {
    return normalizeMediaItems(JSON.parse(decodeURIComponent(s.slice(MEDIA_BUNDLE_PREFIX.length))));
  } catch {
    return null;
  }
}

module.exports = { MEDIA_BUNDLE_PREFIX, normalizeMediaItems, encodeMediaBundle, decodeMediaBundle };
