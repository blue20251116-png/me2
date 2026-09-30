const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

function run(cmd, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('영상 편집 시간이 초과되었습니다.'));
      if (code !== 0) return reject(new Error(`영상 편집 실패: ${stderr.slice(-1200)}`));
      resolve({ stdout, stderr });
    });
  });
}

async function probeDuration(videoPath) {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ], 10000);
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상 길이를 확인할 수 없습니다.');
  return duration;
}

async function editVideo({ inputPath, outputDir, start = 0, end = null, mute = true }) {
  const duration = await probeDuration(inputPath);
  let safeStart = Number(start);
  let safeEnd = end === null || end === '' || end === undefined ? duration : Number(end);

  if (!Number.isFinite(safeStart)) safeStart = 0;
  if (!Number.isFinite(safeEnd)) safeEnd = duration;
  safeStart = Math.max(0, Math.min(safeStart, Math.max(0, duration - 0.1)));
  safeEnd = Math.max(safeStart + 0.1, Math.min(safeEnd, duration));

  const clipDuration = safeEnd - safeStart;
  if (clipDuration < 0.5) throw new Error('편집 구간은 최소 0.5초 이상이어야 합니다.');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filename = `edited-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
  const outputPath = path.join(outputDir, filename);

  const args = [
    '-y',
    '-ss', String(safeStart),
    '-i', inputPath,
    '-t', String(clipDuration),
    '-map', '0:v:0',
  ];

  if (mute) {
    args.push('-an');
  } else {
    args.push('-map', '0:a?');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart'
  );

  if (!mute) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push(outputPath);

  await run(FFMPEG_PATH, args);

  const stat = fs.statSync(outputPath);
  if (stat.size > MAX_OUTPUT_BYTES) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw new Error('편집된 영상이 200MB를 초과했습니다.');
  }

  return {
    filename,
    filepath: outputPath,
    size: stat.size,
    sourceDuration: duration,
    start: safeStart,
    end: safeEnd,
    duration: clipDuration,
    muted: !!mute,
  };
}

module.exports = { probeDuration, editVideo };
