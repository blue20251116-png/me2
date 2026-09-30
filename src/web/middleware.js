'use strict';
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { UPLOADS_DIR } = require('../config/paths');
const { getAccount } = require('../infra/db');

const uploadsDir = UPLOADS_DIR;
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_MEDIA_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/mp4|video\/quicktime)$/;
// 영상 프레임 추출(POST /api/video/frames)이 "이 영상이 정말 이 계정 소유인지"를 파일 경로만으로
// 판단할 수 있도록, 영상 파일은 계정별 하위 폴더(uploads/videos/<accountId>/)에 저장한다.
// 이미지는 기존과 동일하게 uploadsDir 바로 아래에 평평하게 저장 (기존 동작 유지).
// 이 라우트는 requireAccount가 upload.single(...)보다 먼저 실행되므로, 아래 destination
// 콜백이 호출되는 시점에는 이미 req.account가 채워져 있다.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.mimetype.startsWith('video/') && req.account) {
        const dir = path.join(uploadsDir, 'videos', String(req.account.id));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return cb(null, dir);
      }
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MEDIA_TYPES.test(file.mimetype)) {
      return cb(new Error('지원하지 않는 파일 형식입니다 (jpg/png/gif/webp/mp4/mov만 가능)'));
    }
    cb(null, true);
  },
});

function getPublicBaseUrl(req, account) {
  if (account?.threads_redirect_uri) {
    try {
      const u = new URL(account.threads_redirect_uri);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

// 요청에서 accountId를 뽑아서 계정 레코드를 붙여주는 미들웨어
function requireAccount(req, res, next) {
  const accountId = Number(req.query.accountId || req.body?.accountId || req.params.accountId);
  if (!accountId) return res.status(400).json({ error: 'accountId가 필요합니다' });
  const account = getAccount(accountId);
  if (!account) return res.status(404).json({ error: '존재하지 않는 계정입니다' });
  // 소유권 검증: 다른 회원의 스레드 계정을 accountId만 바꿔서 접근하는 걸 서버에서 차단
  if (account.user_id !== req.currentUser.id) {
    return res.status(403).json({ error: '본인 소유의 계정만 이용할 수 있습니다' });
  }
  req.account = account;
  next();
}

module.exports = { uploadsDir, upload, getPublicBaseUrl, requireAccount };
