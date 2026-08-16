const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getSystemApiSettings } = require('./db');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const uploadsDir = path.join(__dirname, 'uploads');
const outputRoot = path.join(uploadsDir, 'youtube-thumbnails');
const DOWNLOAD_TIMEOUT_MS = 12000;
const FFMPEG_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeBaseUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function publicBaseUrlFromAccount(account) {
  // 1순위: Railway/운영환경에서 명시한 공개 서비스 URL
  const explicit = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN);
  if (explicit) return explicit;

  // 2순위: 관리자 공용 Threads callback URL의 origin 사용
  try {
    const shared = getSystemApiSettings();
    const sharedBase = normalizeBaseUrl(shared?.threads_redirect_uri);
    if (sharedBase) return sharedBase;
  } catch {
    // 시스템 설정 조회 실패 시 아래 fallback으로 진행
  }

  // 3순위: 구버전 계정별 redirect URI 호환
  return normalizeBaseUrl(account?.threads_redirect_uri);
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
        return reject(new Error(`ffmpeg 썸네일 크롭 실패 (code ${code}): ${stderr.slice(0, 500)}`));
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
 * Shorts 썸네일은 YouTube가 16:9 가로 캔버스 안에 세로 영상을 중앙 배치하고
 * 좌우에 흐린/어두운 확장 영역을 넣는 경우가 많다.
 * 사용자 예시 기준 중앙 약 44%만 남기면 좌우 복제 영역이 대부분 제거된다.
 *
 * 기존 min()/쉼표 기반 표현은 일부 FFmpeg 빌드에서 필터 파싱이 불안정할 수 있어
 * 단순 비율식으로 교체했다. shell:false라 사용자 입력이 FFmpeg 인자로 들어가지 않는다.
 */
async function cropYoutubeThumbnail({ account, thumbnailUrl, videoId }) {
  if (!account?.id || !thumbnailUrl) throw new Error('썸네일 크롭 정보가 부족합니다');

  const baseUrl = publicBaseUrlFromAccount(account);
  if (!baseUrl) {
    throw new Error(
      '공개 서비스 URL을 확인할 수 없습니다. PUBLIC_BASE_URL 또는 관리자 Threads callback URL을 확인하세요'
    );
  }

  cleanupOldFiles();

  const accountDir = path.join(outputRoot, String(account.id));
  fs.mkdirSync(accountDir, { recursive: true });

  const stablePart = String(videoId || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80) || 'thumb';
  const nonce = crypto.randomBytes(4).toString('hex');
  const inputPath = path.join(accountDir, `${stablePart}-${nonce}-source.jpg`);
  const outputName = `${stablePart}-${nonce}-center.jpg`;
  const outputPath = path.join(accountDir, outputName);

  try {
    await downloadThumbnail(thumbnailUrl, inputPath);

    // 가운데 44%만 사용: 좌우 각각 28% 제거.
    // 높이는 그대로 유지하고, 결과 너비만 SNS에 충분한 720px 수준으로 확대/축소한다.
    const filter = 'crop=iw*0.44:ih:iw*0.28:0,scale=720:-2';

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

    console.log(`[ThumbnailCrop] 중앙 44% 크롭 성공 video=${stablePart}`);
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
