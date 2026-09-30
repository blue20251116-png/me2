'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, logUsage } = require('../../infra/db');
const videoFrames = require('../../content/videoFrames');
const frameVision = require('../../content/frameVision');
const { requireAccount, getPublicBaseUrl, upload, uploadsDir } = require('../middleware');

const router = express.Router();

// ---------- 직접 업로드한 사진/영상 첨부 ----------
router.post('/api/upload-media', requireAccount, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  // 영상은 uploads/videos/<accountId>/ 하위에 저장되므로, 실제 저장 위치를 그대로 반영해 URL을 만든다
  // (이미지는 기존처럼 uploadsDir 바로 아래라 relPath === filename과 동일함)
  const relPath = path.relative(uploadsDir, req.file.path).split(path.sep).join('/');
  const url = `${getPublicBaseUrl(req, req.account)}/uploads/${relPath}`;
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  res.json({ url, filename: req.file.filename, mediaType });
});

// Used to search every account's videos/<id>/ folder and delete the first match, with no account
// check - any logged-in user could delete media another tenant's pending post points to. Videos
// are now only deletable from the caller's own folder, and a flat (image) upload only while no
// post references it yet (the UI only deletes right after upload, before the post is saved).
router.delete('/api/upload-media/:filename', requireAccount, (req, res) => {
  const filename = path.basename(req.params.filename); // 경로 조작 방지
  const ownVideo = path.join(uploadsDir, 'videos', String(req.account.id), filename);
  if (fs.existsSync(ownVideo)) {
    fs.unlinkSync(ownVideo);
    return res.json({ ok: true });
  }
  const flatPath = path.join(uploadsDir, filename);
  if (fs.existsSync(flatPath)) {
    const like = `%/uploads/${filename}`;
    const referenced = db
      .prepare('SELECT 1 FROM posts WHERE image_url LIKE ? OR extra_image_url LIKE ? OR video_url LIKE ? LIMIT 1')
      .get(like, like, like);
    if (referenced) return res.status(409).json({ error: '예약된 글이 사용 중인 파일은 삭제할 수 없습니다' });
    fs.unlinkSync(flatPath);
  }
  res.json({ ok: true });
});

// ---------- 영상 프레임 추출 (업로드한 영상 → 게시용 사진 후보) ----------
// 다운로드/타 사용자 영상 처리 아님 — 오직 "이 계정이 방금 직접 업로드한 영상"만 대상으로 한다.
// 소유권은 파일 경로 구조로 강제된다: 영상은 uploads/videos/<accountId>/에, 추출된 프레임은
// uploads/frames/<accountId>/<jobId>/에 저장되고, 두 라우트 모두 req.account.id로만 그 경로를
// 직접 조립한다 — 클라이언트가 accountId나 다른 경로 조각을 넣어도 그 값은 절대 쓰이지 않는다.
const videoFrameLocks = new Set(); // 계정당 동시 추출 1개로 제한 (연타/중복 방지, 인스턴스 로컬)

router.post('/api/video/frames', requireAccount, async (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename이 필요합니다' });

  if (videoFrameLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 처리 중인 영상이 있습니다. 완료 후 다시 시도해주세요.' });
  }

  // 클라이언트가 보낸 filename은 basename만 신뢰하고, 실제 경로는 서버가 "현재 로그인 계정 자신의
  // 영상 폴더" 기준으로만 조립한다 — 다른 계정 폴더를 가리킬 방법이 없다 (path traversal 방지 포함).
  const safeFilename = path.basename(String(filename));
  const videoPath = path.join(uploadsDir, 'videos', String(req.account.id), safeFilename);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: '영상 파일을 찾을 수 없습니다. 먼저 영상을 업로드해주세요.' });
  }

  videoFrameLocks.add(req.account.id);
  try {
    const availability = await videoFrames.checkFfmpegAvailable();
    if (!availability.available) {
      return res
        .status(503)
        .json({ error: '현재 서버에서 영상 프레임 추출 기능을 사용할 수 없습니다. FFmpeg 설치 상태를 확인해주세요.' });
    }

    const jobId = crypto.randomUUID();
    const outputDir = path.join(uploadsDir, 'frames', String(req.account.id), jobId);

    const { duration, frames } = await videoFrames.extractFrames({ videoPath, outputDir });

    const baseUrl = getPublicBaseUrl(req, req.account);
    const framesOut = frames.map(f => ({
      id: `frame_${f.filename.replace(/[^0-9]/g, '')}`,
      time: f.time,
      url: `${baseUrl}/uploads/frames/${req.account.id}/${jobId}/${f.filename}`,
    }));

    // AI 추천(POST /api/video/frames/:jobId/recommend)이 나중에 클라이언트를 신뢰하지 않고도
    // 이 작업의 프레임 목록을 다시 구성할 수 있도록, 파일명만 최소한으로 기록해둔다.
    try {
      fs.writeFileSync(
        path.join(outputDir, 'manifest.json'),
        JSON.stringify({ duration, frames: frames.map(f => ({ time: f.time, filename: f.filename })) })
      );
    } catch (manifestErr) {
      // manifest 기록 실패는 AI 추천 기능만 못 쓰게 될 뿐 — 프레임 추출 자체는 이미 성공했으므로 무시
      console.log('[영상 프레임] manifest 기록 실패:', manifestErr.message);
    }

    res.json({ success: true, jobId, duration, frames: framesOut });
  } catch (err) {
    if (err.message === '영상 처리 시간이 초과되었습니다.') {
      return res.status(504).json({ error: err.message });
    }
    if (err.message === '영상 파일을 분석할 수 없습니다.') {
      return res.status(422).json({ error: err.message });
    }
    console.error('[영상 프레임 추출 오류]', err.message);
    res.status(500).json({ error: '영상 처리 중 오류가 발생했습니다.' });
  } finally {
    videoFrameLocks.delete(req.account.id);
  }
});

// 선택되지 않은(또는 취소된) 추출 작업을 정리. jobId는 항상 req.account.id 하위에서만 찾으므로
// 다른 계정의 작업 폴더는 애초에 경로 자체가 만들어지지 않는다 (403 대신 자연히 접근 불가).
router.delete('/api/video/frames/:jobId', requireAccount, (req, res) => {
  const jobId = path.basename(req.params.jobId);
  const dir = path.join(uploadsDir, 'frames', String(req.account.id), jobId);
  videoFrames.deleteFramesDir(dir);
  res.json({ ok: true });
});

// ---------- AI 베스트컷 추천 (이미 추출된 프레임을 Claude Vision으로 분석) ----------
// 실패해도(Key 없음/네트워크 오류/응답 파싱 실패 등) 전체 기능이 죽지 않도록 422로 부드럽게 응답한다 —
// 프론트는 이 경우 "AI 추천 없이 수동 선택 가능" 상태로 넘어가면 된다.
const visionLocks = new Set(); // 계정당 동시 분석 1개 (연타 방지, imageGenerationLocks와 동일 패턴)

router.post('/api/video/frames/:jobId/recommend', requireAccount, async (req, res) => {
  const jobId = path.basename(req.params.jobId);
  const jobDir = path.join(uploadsDir, 'frames', String(req.account.id), jobId);
  const manifestPath = path.join(jobDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: '프레임 작업을 찾을 수 없습니다. 먼저 프레임을 추출해주세요.' });
  }
  if (visionLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 분석 중입니다, 잠시 후 다시 시도해주세요' });
  }

  visionLocks.add(req.account.id);
  try {
    // 클라이언트가 보낸 프레임 목록을 신뢰하지 않고, 이 계정 자신의 작업 폴더에 실제로 존재하는
    // manifest+파일만 근거로 분석 대상을 구성한다 (다른 회원 프레임을 분석시킬 방법이 없음).
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return res.status(500).json({ error: '프레임 정보를 읽을 수 없습니다.' });
    }

    const baseUrl = getPublicBaseUrl(req, req.account);
    const frames = (manifest.frames || [])
      .filter(f => fs.existsSync(path.join(jobDir, f.filename)))
      .map(f => ({
        id: `frame_${f.filename.replace(/[^0-9]/g, '')}`,
        url: `${baseUrl}/uploads/frames/${req.account.id}/${jobId}/${f.filename}`,
      }));

    if (!frames.length) {
      return res.status(404).json({ error: '분석할 프레임이 없습니다.' });
    }

    const recommendations = await frameVision.analyzeFrames(req.account.id, frames);
    const ranked = frameVision.rankRecommendations(recommendations);
    logUsage(req.currentUser.id, 'image');

    res.json({
      success: true,
      recommendations,
      recommended: ranked.slice(0, 2).map(r => r.frameId), // Threads 이미지 최대 2장에 맞춰 상위 2개만
    });
  } catch (err) {
    console.log('[Vision] 분석 실패 — 수동 선택으로 폴백:', err.response?.data?.error?.message || err.message);
    res.status(422).json({ error: 'AI 추천을 사용할 수 없습니다. 프레임을 직접 선택해주세요.' });
  } finally {
    visionLocks.delete(req.account.id);
  }
});

module.exports = router;
