const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const uploadsDir = path.join(__dirname, 'uploads');
const outputRoot = path.join(uploadsDir, 'youtube-thumbnails');
const DOWNLOAD_TIMEOUT_MS = 12000;
const FFMPEG_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function publicBaseUrlFromAccount(account) {
  if (!account?.threads_redirect_uri) return '';
  try {
    const u = new URL(account.threads_redirect_uri);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(FFMPEG_PATH, args, { shell: false });
    } catch (err) {
      return reject(err);
    }

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);

    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 100000) stderr = stderr.slice(-100000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('YouTube 썸네일 크롭 시간 초과'));
      if (code !== 0) {
        return reject(new Error(`ffmpeg 썸네일 크롭 실패 (code ${code}): ${stderr.slice(0, 300)}`));
      }
      resolve();
    });
  });
}

function cleanupOldFiles() {
  try {
    if (!fs.existsSync(outputRoot)) return;
    const now = Date.now();
    for (const accountDir of fs.readdirSync(outputRoot)) {
      const dir = path.join(outputRoot, accountDir);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const s = fs.statSync(file);
          if (s.isFile() && now - s.mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
        } catch {
          // 정리 실패는 게시 흐름을 막지 않는다.
        }
      }
    }
  } catch {
    // 정리는 부가 기능이므로 무시.
  }
}

async function downloadThumbnail(url, destination) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error('YouTube 썸네일 응답이 이미지가 아닙니다');
  }

  const data = Buffer.from(res.data);
  if (!data.length || data.length > MAX_DOWNLOAD_BYTES) {
    throw new Error('YouTube 썸네일 파일 크기가 올바르지 않습니다');
  }
  fs.writeFileSync(destination, data);
}

/**
 * YouTube의 가로 썸네일에서 중앙 세로 쇼츠 영역만 자동 크롭한다.
 * crop 식: 입력 높이를 그대로 쓰고, 너비를 9:16 비율로 중앙에서 잘라낸다.
 * 예: 1280x720 -> 약 405x720 중앙 영역.
 *
 * 실패 시 예외를 던진다. 호출하는 scheduler는 반드시 원본 thumbnail로 fallback해야 한다.
 */
async function cropYoutubeThumbnail({ account, thumbnailUrl, videoId }) {
  if (!account?.id || !thumbnailUrl) throw new Error('썸네일 크롭 정보가 부족합니다');

  const baseUrl = publicBaseUrlFromAccount(account);
  if (!baseUrl) throw new Error('공개 서비스 URL을 확인할 수 없습니다');

  cleanupOldFiles();

  const accountDir = path.join(outputRoot, String(account.id));
  fs.mkdirSync(accountDir, { recursive: true });

  const stablePart = String(videoId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'thumb';
  const nonce = crypto.randomBytes(4).toString('hex');
  const inputPath = path.join(accountDir, `${stablePart}-${nonce}-source.jpg`);
  const outputName = `${stablePart}-${nonce}-portrait.jpg`;
  const outputPath = path.join(accountDir, outputName);

  try {
    await downloadThumbnail(thumbnailUrl, inputPath);

    // 중앙 9:16 크롭. 원본 자체가 세로이거나 9:16보다 좁은 경우에는
    // crop 너비가 원본보다 커지지 않도록 min(iw, ih*9/16)을 사용한다.
    // crop 높이는 해당 너비로 만들 수 있는 최대 16:9 세로 높이와 원본 높이 중 작은 값.
    const filter = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)':'(iw-ow)/2':'(ih-oh)/2',scale='min(1080,iw)':-2";

    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-vf', filter,
      '-frames:v', '1',
      '-q:v', '3',
      outputPath,
    ]);

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      throw new Error('크롭된 썸네일 파일 생성 실패');
    }

    return `${baseUrl}/uploads/youtube-thumbnails/${account.id}/${outputName}`;
  } finally {
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch {
      // 임시 원본 삭제 실패는 무시.
    }
  }
}

module.exports = {
  cropYoutubeThumbnail,
};
