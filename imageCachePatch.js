const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const threadsApi = require('./threadsApi');

const uploadsDir = path.join(__dirname, 'uploads');
const MEDIA_BUNDLE_PREFIX = '__THREADS_MEDIA_BUNDLE__';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function getPublicBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(explicit)) return explicit;
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (railway) return `https://${railway}`;
  throw new Error('공개 서비스 주소를 확인할 수 없습니다. PUBLIC_BASE_URL 또는 RAILWAY_PUBLIC_DOMAIN이 필요합니다.');
}

function publicUploadUrl(filename) {
  return `${getPublicBaseUrl()}/uploads/${encodeURIComponent(filename)}`;
}

function isLocalUploadUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}

function extFromContentType(type, rawUrl) {
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  const byType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heic',
    'image/avif': '.avif',
  };
  if (byType[t]) return byType[t];
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {}
  return '.jpg';
}

async function cacheImage(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`이미지 URL 형식이 올바르지 않습니다: ${url.slice(0, 120)}`);
  if (isLocalUploadUrl(url)) return url;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      referer: 'https://www.threads.com/',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
    validateStatus: status => status >= 200 && status < 400,
  });

  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`이미지 파일이 아닌 응답을 받았습니다 (${type || 'unknown'}).`);

  const body = Buffer.from(response.data || []);
  if (body.length < 512) throw new Error(`이미지 파일이 비정상적으로 작습니다 (${body.length} bytes).`);
  if (body.length > MAX_IMAGE_BYTES) throw new Error(`이미지가 ${MAX_IMAGE_BYTES / 1024 / 1024}MB를 초과합니다.`);

  const ext = extFromContentType(type, url);
  const filename = `threads-img-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, body, { flag: 'wx' });
  const localUrl = publicUploadUrl(filename);
  console.log(`[Autopilot][IMAGE CACHE] 성공 bytes=${body.length} sourceHost=${new URL(url).hostname} file=${filename}`);
  return localUrl;
}

function decodeBundle(value) {
  const s = String(value || '');
  if (!s.startsWith(MEDIA_BUNDLE_PREFIX)) return null;
  try {
    const items = JSON.parse(decodeURIComponent(s.slice(MEDIA_BUNDLE_PREFIX.length)));
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function encodeBundle(items) {
  return `${MEDIA_BUNDLE_PREFIX}${encodeURIComponent(JSON.stringify(items))}`;
}

async function cacheBundleImages(bundleValue) {
  const items = decodeBundle(bundleValue);
  if (!items) return bundleValue;
  const out = [];
  let originalImages = 0;
  let cachedImages = 0;
  for (const item of items) {
    const type = String(item?.type || '').toUpperCase();
    const url = String(item?.url || '').trim();
    if (!url) continue;
    if (type === 'IMAGE') {
      originalImages += 1;
      const cached = await cacheImage(url);
      cachedImages += 1;
      out.push({ ...item, type: 'IMAGE', url: cached });
    } else {
      out.push(item);
    }
  }
  console.log(`[Autopilot][IMAGE CACHE] 원본=${originalImages} 로컬성공=${cachedImages}`);
  if (cachedImages !== originalImages) throw new Error(`Threads 원본 이미지 ${originalImages}장 중 ${cachedImages}장만 로컬 캐시에 성공했습니다.`);
  return encodeBundle(out);
}

const originalPublishPost = threadsApi.publishPost.bind(threadsApi);
const originalPublishCarouselPost = threadsApi.publishCarouselPost.bind(threadsApi);
const originalPublishMediaItemsPost = threadsApi.publishMediaItemsPost.bind(threadsApi);

threadsApi.publishPost = async function patchedPublishPost(accountId, { text, imageUrl, videoUrl }) {
  let nextImageUrl = imageUrl;
  if (decodeBundle(imageUrl)) nextImageUrl = await cacheBundleImages(imageUrl);
  else if (imageUrl) nextImageUrl = await cacheImage(imageUrl);
  return originalPublishPost(accountId, { text, imageUrl: nextImageUrl, videoUrl });
};

threadsApi.publishCarouselPost = async function patchedPublishCarouselPost(accountId, { text, imageUrls }) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  const cached = [];
  for (const url of urls) cached.push(await cacheImage(url));
  console.log(`[Autopilot][IMAGE CACHE] 원본=${urls.length} 로컬성공=${cached.length}`);
  if (cached.length !== urls.length) throw new Error(`Threads 원본 이미지 ${urls.length}장 중 ${cached.length}장만 로컬 캐시에 성공했습니다.`);
  return originalPublishCarouselPost(accountId, { text, imageUrls: cached });
};

threadsApi.publishMediaItemsPost = async function patchedPublishMediaItemsPost(accountId, { text, mediaItems }) {
  const items = [];
  let originalImages = 0;
  let cachedImages = 0;
  for (const item of Array.isArray(mediaItems) ? mediaItems : []) {
    if (String(item?.type || '').toUpperCase() === 'IMAGE' && item?.url) {
      originalImages += 1;
      items.push({ ...item, url: await cacheImage(item.url) });
      cachedImages += 1;
    } else {
      items.push(item);
    }
  }
  if (originalImages) console.log(`[Autopilot][IMAGE CACHE] 원본=${originalImages} 로컬성공=${cachedImages}`);
  if (cachedImages !== originalImages) throw new Error(`Threads 원본 이미지 ${originalImages}장 중 ${cachedImages}장만 로컬 캐시에 성공했습니다.`);
  return originalPublishMediaItemsPost(accountId, { text, mediaItems: items });
};

console.log('[Threads][IMAGE CACHE PATCH] 외부 Threads/Instagram 이미지를 Railway uploads에 로컬 캐시 후 발행');
