const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 사용자가 직접 업로드한 영상에서 프레임(장면)을 이미지로 추출하는 모듈.
// - shell 문자열을 절대 조합하지 않는다 (spawn만 사용, shell:true 금지)
// - 서버가 미리 정한 인자만 사용한다 (사용자가 FFmpeg 인자를 지정할 수 없음)
// - 이 모듈은 어떤 파일이 어느 계정 소유인지 모른다 — 그건 호출하는 쪽(server.js)이
//   경로를 만들 때 이미 검증/결정해서 넘겨준 videoPath를 그대로 신뢰하고 실행만 한다.

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

const PER_COMMAND_TIMEOUT_MS = 20000; // 프레임 1장 추출/probe 1회당 타임아웃
const JOB_TIMEOUT_MS = 100000; // 전체 추출 작업 타임아웃 (60~120초 권장 범위 내)
const MAX_WIDTH = 1440;
const JPEG_QUALITY = 4; // ffmpeg -q:v 스케일 (2=고화질 ~ 31=저화질), 4면 SNS 게시에 충분

// child_process.spawn을 Promise로 감싸고, 지정한 시간(ms) 내에 끝나지 않으면 kill.
// stdout/stderr는 필요한 만큼만 버퍼링한다 (큰 바이너리 출력은 없음 — 텍스트/이미지 파일 출력이라 stdout은 짧음).
function runCommand(cmd, args, { timeoutMs = PER_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell:true를 절대 쓰지 않는다 — 인자 배열 그대로 실행되므로 셸 인젝션 여지가 없다.
      child = spawn(cmd, args, { shell: false });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000); // 방어적 상한
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT = 바이너리 자체가 없음 (FFmpeg/FFprobe 미설치)
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error('영상 처리 시간이 초과되었습니다.'));
      }
      if (code !== 0) {
        return reject(new Error(`${path.basename(cmd)} 실행 실패 (code ${code}): ${stderr.slice(0, 500)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// FFmpeg/FFprobe가 실제로 설치되어 있는지 확인. 앱 시작 시가 아니라 요청이 올 때만 체크한다
// (설치 안 되어 있어도 서버 자체는 정상 기동해야 하므로).
async function checkFfmpegAvailable() {
  const check = async (cmd) => {
    try {
      await runCommand(cmd, ['-version'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check(FFMPEG_PATH), check(FFPROBE_PATH)]);
  return { ffmpeg, ffprobe, available: ffmpeg && ffprobe };
}

// ffprobe로 영상 duration(초)을 얻는다. 손상되었거나 영상 스트림이 없으면 예외를 던진다.
async function probeDuration(videoPath) {
  let stdout;
  try {
    const res = await runCommand(FFPROBE_PATH, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    stdout = res.stdout;
  } catch (err) {
    throw new Error('영상 파일을 분석할 수 없습니다.');
  }

  // stream=duration과 format=duration 둘 다 출력되므로 첫 번째 유효한 숫자를 사용
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const duration = lines.map(Number).find((n) => Number.isFinite(n) && n > 0);

  if (!duration) {
    throw new Error('영상 파일을 분석할 수 없습니다.');
  }
  return duration;
}

// 영상 길이(초)를 기준으로 균등하게 추출할 시점(초) 배열을 계산한다.
// 전체 길이의 5%~95% 구간에서 균등 추출 (맨 앞/뒤는 검은 화면/전환일 수 있어 제외).
function computeExtractionTimestamps(duration) {
  let maxFrames;
  if (duration <= 15) maxFrames = 8;
  else if (duration <= 30) maxFrames = 10;
  else if (duration <= 60) maxFrames = 12;
  else maxFrames = 15;

  // 아주 짧은 영상은 후보 수를 줄여서 시점이 겹치지 않게 한다
  maxFrames = Math.max(1, Math.min(maxFrames, Math.floor(duration) || 1));

  const start = duration * 0.05;
  const end = duration * 0.95;

  const timestamps = [];
  if (maxFrames === 1) {
    timestamps.push(Number(((start + end) / 2).toFixed(2)));
  } else {
    for (let i = 0; i < maxFrames; i++) {
      const t = start + (i * (end - start)) / (maxFrames - 1);
      timestamps.push(Number(t.toFixed(2)));
    }
  }
  return timestamps;
}

// 한 시점(t초)에서 프레임 1장을 JPEG로 추출.
// -ss를 -i 앞에 둬서 빠른 탐색을 사용 (프레임 후보 탐색 목적이라 정밀도보다 속도 우선).
// scale 필터로 최대 너비만 제한하고 비율은 그대로 유지 (강제 crop 없음, 업스케일 없음).
async function extractOneFrame(videoPath, time, outputPath) {
  await runCommand(FFMPEG_PATH, [
    '-y',
    '-ss', String(time),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale='min(${MAX_WIDTH},iw)':-2`,
    '-q:v', String(JPEG_QUALITY),
    outputPath,
  ]);
}

// videoPath에서 프레임 후보들을 추출해 outputDir에 저장하고, {time, filename} 목록을 반환.
// 전체 작업은 JOB_TIMEOUT_MS를 넘기면 중단하고 예외를 던진다 (부분 결과를 신뢰할 수 없어 명확히 실패 처리).
async function extractFrames({ videoPath, outputDir }) {
  const duration = await probeDuration(videoPath);
  const timestamps = computeExtractionTimestamps(duration);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const jobStarted = Date.now();
  const frames = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (Date.now() - jobStarted > JOB_TIMEOUT_MS) {
      throw new Error('영상 처리 시간이 초과되었습니다.');
    }
    const t = timestamps[i];
    const filename = `frame_${String(i + 1).padStart(2, '0')}.jpg`;
    const outputPath = path.join(outputDir, filename);
    try {
      await extractOneFrame(videoPath, t, outputPath);
      frames.push({ time: t, filename });
    } catch (err) {
      // 특정 시점 하나만 실패하면(예: 그 지점이 유효하지 않은 프레임) 그 프레임만 건너뛰고 계속 진행 —
      // 영상 전체가 손상된 게 아니라면 나머지 시점에서는 정상 추출되는 경우가 많다.
      console.log(`[videoFrames] ${t}s 프레임 추출 실패, 건너뜀: ${err.message}`);
    }
  }

  if (!frames.length) {
    throw new Error('영상 파일을 분석할 수 없습니다.');
  }

  return { duration, frames };
}

// 작업 디렉터리(및 그 안의 모든 프레임 파일) 삭제. 존재하지 않으면 조용히 무시.
function deleteFramesDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  checkFfmpegAvailable,
  probeDuration,
  computeExtractionTimestamps,
  extractFrames,
  deleteFramesDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
};
