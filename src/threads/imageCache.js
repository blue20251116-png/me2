'use strict';
// Threads fetches media by URL, so external images are downloaded once into the uploads volume
// under a deterministic name (idempotent across retries) and re-served from our public URL.
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const { publicUploadUrl } = require('../config/publicUrl');

const uploadsDir = UPLOADS_DIR;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function isLocalUploadUrl(raw) {
  try {
    return new URL(String(raw || '')).pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}
function extFromContentType(type, rawUrl) {
  const t = String(type || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
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
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif'].includes(ext))
      return ext === '.jpeg' ? '.jpg' : ext;
  } catch {}
  return '.jpg';
}
// posts.image_url in the DB always stays the ORIGINAL external Threads/Instagram URL (nothing ever
// writes the cached local URL back to it), so the filename must be deterministic from the source
// URL - otherwise every retry of a post whose publish failed for an unrelated reason re-downloads
// and re-writes a brand new duplicate copy of the same image, growing the persistent volume without bound.
function cacheFilePrefix(url) {
  return `threads-img-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}
function findCachedFile(prefix) {
  try {
    return fs.readdirSync(uploadsDir).find(f => f.startsWith(prefix)) || null;
  } catch {
    return null;
  }
}
async function cacheImage(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`이미지 URL 형식이 올바르지 않습니다: ${url.slice(0, 120)}`);
  if (isLocalUploadUrl(url)) return url;

  const prefix = cacheFilePrefix(url);
  const cachedFile = findCachedFile(prefix);
  if (cachedFile) {
    console.log(`[Autopilot][IMAGE CACHE] 재사용(이미 캐시됨) file=${cachedFile}`);
    return publicUploadUrl(cachedFile);
  }

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
  const filename = `${prefix}${ext}`;
  const filepath = path.join(uploadsDir, filename);
  try {
    fs.writeFileSync(filepath, body, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.log(`[Autopilot][IMAGE CACHE] 동시 캐시 경합 → 기존 파일 재사용 file=${filename}`);
  }
  const localUrl = publicUploadUrl(filename);
  console.log(
    `[Autopilot][IMAGE CACHE] 성공 bytes=${body.length} sourceHost=${new URL(url).hostname} file=${filename}`
  );
  return localUrl;
}

module.exports = { cacheFilePrefix, findCachedFile, cacheImage, uploadsDir };
