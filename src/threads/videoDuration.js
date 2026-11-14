'use strict';
// 2026-11-05 (dev 0079f189): video files are deleted after posting (358 video posts, only 43 files left),
// so the length of a posted video could not be analysed later. The length is now read from the local
// upload when the post is reserved and again at publish time, and kept in posts.video_duration_sec.
// MP4/MOV: read the 'mvhd' box directly (no dependency, no process spawn); anything else falls back to
// ffprobe when it is installed. Never throws - an unknown length is null.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodeMediaBundle } = require('./mediaBundle');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}
// Box list of [start, end) in the file: [{ type, start (payload), end }]
function boxesIn(fd, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end && out.length < 1000) {
    const h = readAt(fd, pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header) break;
    out.push({ type, start: pos + header, end: Math.min(end, pos + size) });
    pos += size;
  }
  return out;
}
function mp4DurationSec(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const total = fs.fstatSync(fd).size;
    const moov = boxesIn(fd, 0, total).find(b => b.type === 'moov');
    if (!moov) return null;
    const mvhd = boxesIn(fd, moov.start, moov.end).find(b => b.type === 'mvhd');
    if (!mvhd) return null;
    const b = readAt(fd, mvhd.start, Math.min(32, mvhd.end - mvhd.start));
    const version = b[0];
    let timescale, duration;
    if (version === 1) {
      if (b.length < 32) return null;
      timescale = b.readUInt32BE(20);
      duration = Number(b.readBigUInt64BE(24));
    } else {
      if (b.length < 20) return null;
      timescale = b.readUInt32BE(12);
      duration = b.readUInt32BE(16);
    }
    if (!timescale || !duration || duration === 0xffffffff) return null;
    return Math.round((duration / timescale) * 100) / 100;
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}
function ffprobeDurationSec(filePath) {
  try {
    const r = spawnSync(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const sec = Number(String(r.stdout || '').trim());
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 100) / 100 : null;
  } catch {
    return null;
  }
}
function probeVideoDurationSec(filePath, { ffprobe = true } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return mp4DurationSec(filePath) ?? (ffprobe ? ffprobeDurationSec(filePath) : null);
}
// The post's video URL: posts.video_url, or the VIDEO item of a media bundle in image_url.
function videoUrlOfPost(post) {
  if (post?.video_url) return String(post.video_url);
  const items = decodeMediaBundle(post?.image_url);
  return items?.find(i => i.type === 'VIDEO')?.url || null;
}
// Our own /uploads/<file> URL -> the local file path (null for foreign URLs or a missing file).
function localUploadPath(url, uploadsDir) {
  try {
    const u = new URL(String(url));
    if (!u.pathname.startsWith('/uploads/')) return null;
    const name = path.basename(decodeURIComponent(u.pathname.slice('/uploads/'.length)));
    const p = path.join(uploadsDir, name);
    return name && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
function postVideoDurationSec(post, uploadsDir, opts) {
  const url = videoUrlOfPost(post);
  if (!url) return null;
  return probeVideoDurationSec(localUploadPath(url, uploadsDir), opts);
}

module.exports = { mp4DurationSec, probeVideoDurationSec, videoUrlOfPost, localUploadPath, postVideoDurationSec };
