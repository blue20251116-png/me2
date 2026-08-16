const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 120000;

function validateXhsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('올바른 샤오홍슈/RedNote URL을 입력해주세요.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('http/https URL만 사용할 수 있습니다.');
  }
  const host = u.hostname.toLowerCase();
  const allowed =
    host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') ||
    host === 'rednote.com' || host.endsWith('.rednote.com') ||
    host === 'xhslink.com' || host.endsWith('.xhslink.com');
  if (!allowed) throw new Error('샤오홍슈/RedNote 공유 URL만 사용할 수 있습니다.');
  return u.toString();
}

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
    child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('샤오홍슈 영상 가져오기 시간이 초과되었습니다.'));
      if (code !== 0) {
        const detail = stderr.slice(-1200);
        if (/captcha|verify|verification|login|sign in|403|forbidden/i.test(detail)) {
          return reject(new Error('샤오홍슈에서 로그인/인증 또는 CAPTCHA를 요구해 영상을 가져오지 못했습니다. 다른 공유 링크로 다시 시도해주세요.'));
        }
        return reject(new Error(`영상 가져오기 실패: ${detail || `yt-dlp 종료코드 ${code}`}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function checkAvailable() {
  try {
    await run(YTDLP_PATH, ['--version'], 5000);
    return true;
  } catch {
    return false;
  }
}

async function downloadVideo({ url, outputDir }) {
  const safeUrl = validateXhsUrl(url);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const id = `xhs-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const template = path.join(outputDir, `${id}.%(ext)s`);

  await run(YTDLP_PATH, [
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', String(MAX_BYTES),
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--print', 'after_move:filepath',
    '-o', template,
    safeUrl,
  ]);

  const matches = fs.readdirSync(outputDir)
    .filter(name => name.startsWith(`${id}.`))
    .map(name => ({ name, full: path.join(outputDir, name), stat: fs.statSync(path.join(outputDir, name)) }))
    .filter(x => x.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  if (!matches.length) throw new Error('다운로드는 완료됐지만 영상 파일을 찾지 못했습니다.');
  let picked = matches[0];
  if (picked.stat.size > MAX_BYTES) {
    try { fs.unlinkSync(picked.full); } catch {}
    throw new Error('영상이 200MB를 초과해서 가져오지 않았습니다.');
  }

  if (path.extname(picked.name).toLowerCase() !== '.mp4') {
    throw new Error('MP4 영상으로 변환하지 못했습니다.');
  }

  return {
    filename: picked.name,
    filepath: picked.full,
    size: picked.stat.size,
    sourceUrl: safeUrl,
  };
}

module.exports = { validateXhsUrl, checkAvailable, downloadVideo, YTDLP_PATH };
