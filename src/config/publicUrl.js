'use strict';
// Public base URL of this deployment (Threads/Meta must fetch uploaded media from it).
// PUBLIC_BASE_URL / APP_URL win; otherwise Railway's RAILWAY_PUBLIC_DOMAIN.
function publicBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (/^https?:\/\//i.test(explicit)) return explicit;
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  return railway ? `https://${railway}` : '';
}

function publicUploadUrl(filename) {
  const base = publicBaseUrl();
  if (!base)
    throw new Error('공개 서비스 주소를 확인할 수 없습니다. PUBLIC_BASE_URL 또는 RAILWAY_PUBLIC_DOMAIN이 필요합니다.');
  return `${base}/uploads/${encodeURIComponent(filename)}`;
}

// Posts store absolute /uploads/ URLs at generation time. On the local PC the quick-tunnel host
// changes on every restart, so a post made before a restart would hand Meta a dead URL
// (THREADS_MEDIA_PROCESSING_FAILED). Re-point our own upload URLs at the current base at publish time.
const OWN_HOST = /(^|\.)(trycloudflare\.com|up\.railway\.app|ngrok-free\.app|localhost)$/i;
function rebaseUploadUrl(url) {
  const base = publicBaseUrl();
  if (!base || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (!OWN_HOST.test(u.hostname) || !u.pathname.startsWith('/uploads/')) return url;
    return `${base}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

module.exports = { publicBaseUrl, publicUploadUrl, rebaseUploadUrl };
