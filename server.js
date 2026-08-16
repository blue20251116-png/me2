require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const session = require('express-session');
const {
  db,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  DEFAULT_DISCLOSURE_TEMPLATE,
  bootstrapAdmin,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  approveUser,
  setUserStatus,
  extendUserExpiry,
  canAddThreadsAccount,
  canPublish,
  logUsage,
  getTodayUsage,
  countAccountsForUser,
  getSiteSettings,
  updateSiteSettings,
  getSystemApiSettings,
  updateSystemApiSettings,
  hasAdmin,
  createInitialAdmin,
  saveMediaSource,
  findMediaSourceForProduct,
} = require('./db');
const { hashPassword, verifyPassword, requireAuth, requireAdmin } = require('./auth');
const threadsApi = require('./threadsApi');
const { scrapeProduct } = require('./scraper');
const coupangApi = require('./coupangApi');
const { generateCaption, suggestKeyword, suggestKeywordCandidates } = require('./aiCaption');
const { generateScene, generateLifestyleImage } = require('./aiImage');
const { rankKeywordsByTrend } = require('./naverTrends');
const { startPublishJob, startInsightsJob, startAutopilotJob } = require('./scheduler');
const youtubeApi = require('./youtubeApi');
const videoFrames = require('./videoFrames');
const frameVision = require('./frameVision');

bootstrapAdmin();

const app = express();
app.use(express.json());
app.set('trust proxy', 1); // Railway 등 프록시 뒤에서 세션 쿠키가 정상 동작하도록

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'threads-scheduler-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30일
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

// ---------- 공개 라우트 (로그인 없이 접근 가능) ----------
app.use(express.static(path.join(__dirname, 'public'), { index: false })); // css/js/로그인 화면 등 정적 자원
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/status.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

app.get('/admin-setup.html', (req, res) => {
  if (hasAdmin()) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'admin-setup.html'));
});

app.get('/api/auth/admin-setup-status', (req, res) => {
  res.json({ needsSetup: !hasAdmin() });
});

app.post('/api/auth/setup-admin', (req, res) => {
  if (hasAdmin()) return res.status(409).json({ error: '이미 관리자 계정이 설정되어 있습니다' });
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '관리자 이메일과 비밀번호가 필요합니다' });
  if (String(password).length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상으로 설정해주세요' });
  try {
    const id = createInitialAdmin(String(email).trim().toLowerCase(), hashPassword(password), name);
    req.session.userId = Number(id);
    res.json({ ok: true, role: 'admin' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 결제 안내(계좌/오픈카톡/문구) — 로그인 전에도 회원가입 화면에서 봐야 하므로 공개
app.get('/api/site-settings', (req, res) => {
  res.json(getSiteSettings());
});

app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호가 필요합니다' });
  if (getUserByEmail(email)) return res.status(400).json({ error: '이미 가입된 이메일입니다' });
  try {
    createUser(email, hashPassword(password), name);
    res.json({ ok: true, message: '가입 신청 완료 — 관리자 승인 후 이용 가능합니다' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
  }
  const isExpired = user.expires_at && new Date(user.expires_at) < new Date();
  const effectiveStatus = user.status === 'active' && isExpired ? 'expired' : user.status;
  if (effectiveStatus !== 'active') {
    return res.status(403).json({ error: '로그인할 수 없는 계정 상태입니다', status: effectiveStatus });
  }
  req.session.userId = user.id;
  res.json({ ok: true, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인이 필요합니다' });
  const user = getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다' });
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    plan: user.plan,
    expires_at: user.expires_at,
    daily_publish_limit: user.daily_publish_limit,
    max_threads_accounts: user.max_threads_accounts,
    threads_account_count: countAccountsForUser(user.id),
    today_usage: getTodayUsage(user.id),
  });
});

// 직접 업로드한 사진/영상 저장 폴더 (Threads API가 공개 URL을 요구하므로 정적 파일로 서빙 — 이건 Meta 서버가
// 세션 쿠키 없이 접근해야 하므로 인증 게이트보다 반드시 앞에 있어야 함. 파일명이 랜덤이라 추측 접근은 어려움)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// ---------- 여기부터는 로그인 + 승인(active) 상태여야만 통과 ----------
app.use(requireAuth);

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(listUsers().map((u) => ({ ...u, password_hash: undefined })));
});

app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  approveUser(Number(req.params.id), req.currentUser.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/suspend', requireAdmin, (req, res) => {
  setUserStatus(Number(req.params.id), 'suspended');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unsuspend', requireAdmin, (req, res) => {
  setUserStatus(Number(req.params.id), 'active');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/grant', requireAdmin, (req, res) => {
  const days = Number(req.body?.days) || 30;
  const newExpiry = extendUserExpiry(Number(req.params.id), days);
  res.json({ ok: true, expires_at: newExpiry });
});

// 계좌/오픈카톡/안내문구 — 회원가입 화면에 보여줄 내용을 관리자가 직접 쓰고 고칠 수 있게
app.get('/api/admin/site-settings', requireAdmin, (req, res) => {
  res.json(getSiteSettings());
});

app.post('/api/admin/site-settings', requireAdmin, (req, res) => {
  updateSiteSettings(req.body || {});
  res.json({ ok: true });
});


// 서비스 전체가 공용으로 사용하는 API 설정 — 관리자 전용.
// secret 값 자체는 GET 응답으로 절대 돌려주지 않는다.
app.get('/api/admin/system-api-settings', requireAdmin, (req, res) => {
  const s = getSystemApiSettings();
  res.json({
    threads_app_id: s.threads_app_id || '',
    threads_redirect_uri: s.threads_redirect_uri || '',
    naver_client_id: s.naver_client_id || '',
    has_threads_app_secret: !!s.threads_app_secret,
    has_openai_api_key: !!s.openai_api_key,
    has_naver_client_secret: !!s.naver_client_secret,
    has_youtube_api_key: !!s.youtube_api_key,
  });
});

app.post('/api/admin/system-api-settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  updateSystemApiSettings({
    threads_app_id: body.threads_app_id,
    threads_app_secret: body.threads_app_secret,
    threads_redirect_uri: body.threads_redirect_uri,
    openai_api_key: body.openai_api_key,
    naver_client_id: body.naver_client_id,
    naver_client_secret: body.naver_client_secret,
    youtube_api_key: body.youtube_api_key,
  });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'))); // index.html(대시보드)은 인증 통과 후에만

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

// ---------- 계정 관리 ----------
app.get('/api/accounts', (req, res) => {
  res.json(listAccounts(req.currentUser.id));
});

app.post('/api/accounts', (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: '계정 이름을 입력해주세요' });
  if (!canAddThreadsAccount(req.currentUser.id)) {
    return res.status(400).json({
      error: `현재 플랜에서는 Threads 계정을 최대 ${req.currentUser.max_threads_accounts}개까지 연결할 수 있습니다.`,
    });
  }
  const id = createAccount(label.trim(), req.currentUser.id);
  res.json({ id });
});

app.put('/api/accounts/:accountId', requireAccount, (req, res) => {
  const { label } = req.body;
  if (label !== undefined) updateAccount(req.account.id, { label: label.trim() });
  res.json({ ok: true });
});

app.delete('/api/accounts/:accountId', requireAccount, (req, res) => {
  deleteAccount(req.account.id);
  res.json({ ok: true });
});

// ---------- 자동발행(오토파일럿) ----------
app.get('/api/accounts/:accountId/autopilot', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    enabled: !!a.autopilot_enabled,
    nextAt: a.autopilot_next_at || null,
    lastKeyword: a.autopilot_last_keyword || null,
    lastTarget: a.autopilot_last_target || null,
    // 관련 쇼츠 콘텐츠 참고 옵션 — 컬럼이 없던 예전 계정(마이그레이션 전)은 기본 ON으로 취급
    youtubeSourceEnabled:
      a.autopilot_youtube_source_enabled === null || a.autopilot_youtube_source_enabled === undefined
        ? true
        : !!a.autopilot_youtube_source_enabled,
    youtubeOrder: a.autopilot_youtube_order || 'relevance',
    // 업로드 영상 프레임(media_sources) 자동 사용 옵션 — 기본 OFF
    frameMediaEnabled: !!a.autopilot_frame_media_enabled,
  });
});

// 완전자동화의 "관련 쇼츠 콘텐츠 참고" ON/OFF + 탐색 방식 저장 (시작/중지와 별개로 언제든 변경 가능)
app.post('/api/accounts/:accountId/autopilot/youtube-settings', requireAccount, (req, res) => {
  const { enabled, order } = req.body || {};
  const allowedOrders = ['relevance', 'viewCount', 'date'];
  updateAccount(req.account.id, {
    autopilot_youtube_source_enabled: enabled ? 1 : 0,
    autopilot_youtube_order: allowedOrders.includes(order) ? order : 'relevance',
  });
  res.json({ ok: true });
});

// 완전자동화의 "업로드 영상 프레임 자동 사용" ON/OFF 저장
app.post('/api/accounts/:accountId/autopilot/frame-media-settings', requireAccount, (req, res) => {
  const { enabled } = req.body || {};
  updateAccount(req.account.id, { autopilot_frame_media_enabled: enabled ? 1 : 0 });
  res.json({ ok: true });
});

app.post('/api/accounts/:accountId/autopilot/start', requireAccount, (req, res) => {
  // 누르자마자 하나 만들어지는 게 아니라 1분 뒤 첫 실행, 이후로는 60~75분 랜덤 간격
  const firstRunAt = new Date(Date.now() + 60 * 1000).toISOString();
  updateAccount(req.account.id, { autopilot_enabled: 1, autopilot_next_at: firstRunAt });
  res.json({ ok: true, nextAt: firstRunAt });
});

app.post('/api/accounts/:accountId/autopilot/stop', requireAccount, (req, res) => {
  updateAccount(req.account.id, { autopilot_enabled: 0 });
  res.json({ ok: true });
});

// ---------- 연결 상태 ----------
app.get('/api/accounts/:accountId/connection-status', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    connected: !!(a.threads_access_token && a.threads_user_id),
    username: a.threads_username || null,
  });
});

// ---------- OAuth ----------
app.get('/auth/login', requireAccount, (req, res) => {
  try {
    res.redirect(threadsApi.getAuthUrl(req.account.id));
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const accountId = Number(state);
    if (!accountId) throw new Error('콜백에 계정 정보(state)가 없습니다');

    const shortLived = await threadsApi.exchangeCodeForToken(accountId, code);
    const longLived = await threadsApi.exchangeForLongLivedToken(accountId, shortLived.access_token);
    let username = null;
    try {
      username = await threadsApi.fetchProfile(longLived.access_token, shortLived.user_id);
    } catch {
      /* 사용자명 조회 실패해도 연결 자체는 계속 진행 */
    }

    updateAccount(accountId, {
      threads_user_id: String(shortLived.user_id),
      threads_access_token: longLived.access_token,
      threads_token_expires_at: String(Date.now() + longLived.expires_in * 1000),
      threads_username: username,
    });

    res.redirect(`/?connected=1&accountId=${accountId}`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('연결 실패: ' + (err.response?.data?.error?.message || err.message));
  }
});

// ---------- 직접 업로드한 사진/영상 첨부 ----------
app.post('/api/upload-media', requireAccount, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  // 영상은 uploads/videos/<accountId>/ 하위에 저장되므로, 실제 저장 위치를 그대로 반영해 URL을 만든다
  // (이미지는 기존처럼 uploadsDir 바로 아래라 relPath === filename과 동일함)
  const relPath = path.relative(uploadsDir, req.file.path).split(path.sep).join('/');
  const url = `${getPublicBaseUrl(req, req.account)}/uploads/${relPath}`;
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  res.json({ url, filename: req.file.filename, mediaType });
});

app.delete('/api/upload-media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // 경로 조작 방지
  // 이미지(평면 위치)를 먼저 확인하고, 없으면 계정별 영상 폴더들에서 찾아 삭제한다
  const flatPath = path.join(uploadsDir, filename);
  if (fs.existsSync(flatPath)) {
    fs.unlinkSync(flatPath);
    return res.json({ ok: true });
  }
  const videosDir = path.join(uploadsDir, 'videos');
  if (fs.existsSync(videosDir)) {
    for (const accountDir of fs.readdirSync(videosDir)) {
      const candidate = path.join(videosDir, accountDir, filename);
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
        break;
      }
    }
  }
  res.json({ ok: true });
});

// ---------- 영상 프레임 추출 (업로드한 영상 → 게시용 사진 후보) ----------
// 다운로드/타 사용자 영상 처리 아님 — 오직 "이 계정이 방금 직접 업로드한 영상"만 대상으로 한다.
// 소유권은 파일 경로 구조로 강제된다: 영상은 uploads/videos/<accountId>/에, 추출된 프레임은
// uploads/frames/<accountId>/<jobId>/에 저장되고, 두 라우트 모두 req.account.id로만 그 경로를
// 직접 조립한다 — 클라이언트가 accountId나 다른 경로 조각을 넣어도 그 값은 절대 쓰이지 않는다.
const videoFrameLocks = new Set(); // 계정당 동시 추출 1개로 제한 (연타/중복 방지, 인스턴스 로컬)

app.post('/api/video/frames', requireAccount, async (req, res) => {
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
    const framesOut = frames.map((f) => ({
      id: `frame_${f.filename.replace(/[^0-9]/g, '')}`,
      time: f.time,
      url: `${baseUrl}/uploads/frames/${req.account.id}/${jobId}/${f.filename}`,
    }));

    // AI 추천(POST /api/video/frames/:jobId/recommend)이 나중에 클라이언트를 신뢰하지 않고도
    // 이 작업의 프레임 목록을 다시 구성할 수 있도록, 파일명만 최소한으로 기록해둔다.
    try {
      fs.writeFileSync(
        path.join(outputDir, 'manifest.json'),
        JSON.stringify({ duration, frames: frames.map((f) => ({ time: f.time, filename: f.filename })) })
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
app.delete('/api/video/frames/:jobId', requireAccount, (req, res) => {
  const jobId = path.basename(req.params.jobId);
  const dir = path.join(uploadsDir, 'frames', String(req.account.id), jobId);
  videoFrames.deleteFramesDir(dir);
  res.json({ ok: true });
});

// ---------- AI 베스트컷 추천 (이미 추출된 프레임을 OpenAI Vision으로 분석) ----------
// 실패해도(Key 없음/네트워크 오류/응답 파싱 실패 등) 전체 기능이 죽지 않도록 422로 부드럽게 응답한다 —
// 프론트는 이 경우 "AI 추천 없이 수동 선택 가능" 상태로 넘어가면 된다.
const visionLocks = new Set(); // 계정당 동시 분석 1개 (연타 방지, imageGenerationLocks와 동일 패턴)

app.post('/api/video/frames/:jobId/recommend', requireAccount, async (req, res) => {
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
      .filter((f) => fs.existsSync(path.join(jobDir, f.filename)))
      .map((f) => ({
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
      recommended: ranked.slice(0, 2).map((r) => r.frameId), // Threads 이미지 최대 2장에 맞춰 상위 2개만
    });
  } catch (err) {
    console.log('[Vision] 분석 실패 — 수동 선택으로 폴백:', err.response?.data?.error?.message || err.message);
    res.status(422).json({ error: 'AI 추천을 사용할 수 없습니다. 프레임을 직접 선택해주세요.' });
  } finally {
    visionLocks.delete(req.account.id);
  }
});

// ---------- AI로 스레드 본문 자동 생성 ----------
app.post('/api/generate-caption', requireAccount, async (req, res) => {
  const { productName, price, target, youtubeSource } = req.body;
  if (!productName) return res.status(400).json({ error: 'productName이 필요합니다' });
  try {
    const texts = await generateCaption(req.account.id, { productName, price, target, youtubeSource });
    logUsage(req.currentUser.id, 'text');
    res.json({ texts });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------- AI가 검색 키워드 자체를 제안 ("AI 자동완성" 흐름) ----------
// 네이버 데이터랩 키가 연결되어 있으면 후보 5개를 실제 검색 트렌드로 비교해서 1위를 고르고,
// 없으면 AI가 제안한 후보 중 첫 번째를 그냥 사용
app.post('/api/suggest-keyword', requireAccount, async (req, res) => {
  const { target } = req.body || {};
  try {
    const candidates = await suggestKeywordCandidates(req.account.id, target);
    logUsage(req.currentUser.id, 'text');
    let keyword = candidates[0];
    let trendUsed = false;

    try {
      const ranked = await rankKeywordsByTrend(req.account.id, candidates);
      if (ranked && ranked.length) {
        keyword = ranked[0].keyword;
        trendUsed = true;
      }
    } catch (trendErr) {
      // 트렌드 조회 실패해도 AI 1순위 키워드로 그냥 진행
      console.error('[트렌드 조회 실패]', trendErr.response?.data || trendErr.message);
    }

    res.json({ keyword, candidates, trendUsed });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------- 쿠팡파트너스 상품 검색 (Open API) ----------
app.get('/api/coupang/search', requireAccount, async (req, res) => {
  const { keyword, limit } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword가 필요합니다' });
  try {
    const products = await coupangApi.searchProducts(req.account.id, keyword, Number(limit) || 10);
    res.json({ products });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/coupang/deeplink', requireAccount, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const [result] = await coupangApi.createDeeplink(req.account.id, [url]);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

// ---------- YouTube 관련 짧은 영상 검색 (콘텐츠 소재 탐색용 — 다운로드 기능 아님) ----------
// YouTube Data API Key는 회원 개별 입력이 아니라 관리자 공용 설정(system_api_settings)에서만 가져온다.
// 일반 회원 응답에는 Key를 절대 포함하지 않는다.
app.get('/api/youtube/search', requireAccount, async (req, res) => {
  const { keyword, order, limit } = req.query;
  if (!keyword || !String(keyword).trim()) {
    return res.status(400).json({ error: 'keyword가 필요합니다' });
  }

  const shared = getSystemApiSettings();
  const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(422).json({ error: '관리자가 YouTube Data API Key를 아직 설정하지 않았습니다.' });
  }

  try {
    const videos = await youtubeApi.searchVideos({
      apiKey,
      keyword,
      order: order || 'relevance',
      maxResults: Number(limit) || 10,
    });
    if (!videos.length) {
      return res.json({ videos: [], message: '관련 영상을 찾지 못했습니다. 검색어를 조금 다르게 입력해보세요.' });
    }
    res.json({ videos });
  } catch (err) {
    const reason = err.response?.data?.error?.errors?.[0]?.reason || '';
    if (err.response?.status === 403 && /quota/i.test(reason)) {
      return res.status(429).json({ error: 'YouTube API 사용량 한도에 도달했습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (err.response) {
      return res.status(422).json({ error: err.response?.data?.error?.message || err.message });
    }
    console.error('[YouTube 검색 오류]', err.message);
    res.status(500).json({ error: 'YouTube 검색 중 오류가 발생했습니다.' });
  }
});

// ---------- 상품 이미지/제목 자동 가져오기 (검색 API를 못 쓸 때의 보조 수단) ----------
app.post('/api/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ---------- 상품 라이프스타일 상황(Scene) 생성 ----------
app.post('/api/generate-scene', requireAccount, async (req, res) => {
  const { productName, price, target } = req.body;
  if (!productName) return res.status(400).json({ error: 'productName이 필요합니다' });
  try {
    const scene = await generateScene(req.account.id, { productName, price, target });
    logUsage(req.currentUser.id, 'text');
    res.json({ scene });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// 이미지 생성은 비용이 크므로, 같은 계정이 동시에 두 번 요청하는 걸(연타/중복 네트워크 재시도) 막아둠
const imageGenerationLocks = new Set();

// ---------- 상품 라이프스타일 이미지 생성 ----------
app.post('/api/generate-lifestyle-image', requireAccount, async (req, res) => {
  const { productName, productImage, scene } = req.body;
  if (!productName || !productImage) {
    return res.status(400).json({ error: 'productName과 productImage가 필요합니다' });
  }
  if (imageGenerationLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 이미지 생성 중입니다, 잠시 후 다시 시도해주세요' });
  }
  imageGenerationLocks.add(req.account.id);
  try {
    const result = await generateLifestyleImage(
      req.account.id,
      { productName, productImageUrl: productImage, scene },
      getPublicBaseUrl(req, req.account)
    );
    logUsage(req.currentUser.id, 'image');
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  } finally {
    imageGenerationLocks.delete(req.account.id);
  }
});

// ---------- 글 등록 (예약) ----------
app.post('/api/posts', requireAccount, (req, res) => {
  const {
    text,
    link,
    image_url,
    extra_image_url,
    video_url,
    scheduled_at,
    auto_comment_enabled,
    product_name,
    frame_job_id,
  } = req.body;
  if (!text || !scheduled_at) {
    return res.status(400).json({ error: 'text와 scheduled_at은 필수입니다' });
  }
  const info = db
    .prepare(
      `INSERT INTO posts (account_id, text, link, image_url, extra_image_url, video_url, scheduled_at, auto_comment_enabled, comment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.account.id,
      text,
      link || null,
      image_url || null,
      // 영상이 있으면 2번째 이미지(캐러셀)는 의미가 없으니 무시
      video_url ? null : extra_image_url || null,
      video_url || null,
      scheduled_at,
      auto_comment_enabled === false ? 0 : 1,
      link ? 'pending' : 'none'
    );

  // 영상 프레임(+상품 이미지) 조합으로 게시한 경우, 나중에 완전자동화가 비슷한 상품을 고를 때
  // 재사용할 수 있도록 이 조합을 최소한으로 기억해둔다 (선택 사항 — 프레임을 안 썼으면 아무 일도 안 함).
  if (product_name && frame_job_id && image_url) {
    try {
      saveMediaSource(req.account.id, {
        productName: product_name,
        frameJobId: frame_job_id,
        imageUrl: image_url,
        extraImageUrl: extra_image_url || null,
      });
    } catch (err) {
      console.log('[Media] media_source 저장 실패(게시 자체는 정상 진행):', err.message);
    }
  }

  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/posts/:id', requireAccount, (req, res) => {
  db.prepare(`DELETE FROM posts WHERE id = ? AND account_id = ? AND status = 'pending'`).run(
    req.params.id,
    req.account.id
  );
  res.json({ ok: true });
});

// ---------- 대시보드용 요약 데이터 ----------
app.get('/api/dashboard', requireAccount, (req, res) => {
  const accountId = req.account.id;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();
  const endOfDay = new Date(startOfDay.getTime() + 24 * 3600 * 1000).toISOString();

  const pendingToday = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .get(accountId, startIso, endOfDay).c;

  const postedToday = db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND status = 'posted' AND posted_at >= ? AND posted_at < ?`
    )
    .all(accountId, startIso, endOfDay);

  const totalScheduled = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND status != 'failed'`
    )
    .get(accountId, startIso, endOfDay).c;

  const postIds = postedToday.map((p) => p.id);
  let totalViews = 0;
  const insightsByPost = {};
  if (postIds.length) {
    const placeholders = postIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM insights WHERE post_id IN (${placeholders})`).all(...postIds);
    for (const r of rows) {
      totalViews += r.views || 0;
      insightsByPost[r.post_id] = r;
    }
  }

  const next = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? AND status = 'pending' ORDER BY scheduled_at ASC LIMIT 1`)
    .get(accountId);

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, views: 0 }));
  for (const p of postedToday) {
    const h = new Date(p.posted_at).getHours();
    hourly[h].count += 1;
    hourly[h].views += insightsByPost[p.id]?.views || 0;
  }
  const pendingRows = db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .all(accountId, startIso, endOfDay);
  for (const p of pendingRows) {
    const h = new Date(p.scheduled_at).getHours();
    hourly[h].count += 1;
  }

  res.json({
    pendingToday,
    postedTodayCount: postedToday.length,
    totalScheduled,
    totalViews,
    nextPost: next || null,
    hourly,
    postedToday: postedToday.map((p) => ({ ...p, insights: insightsByPost[p.id] || null })),
  });
});

app.get('/api/posts', requireAccount, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? ORDER BY scheduled_at DESC LIMIT 200`)
    .all(req.account.id);
  res.json(rows);
});

// ---------- 계정 설정 (App ID/Secret, 쿠팡 키, AI 키, 안내문구 템플릿) ----------
app.get('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    label: a.label,
    THREADS_APP_ID: a.threads_app_id || '',
    THREADS_REDIRECT_URI: a.threads_redirect_uri || '',
    hasThreadsSecret: !!a.threads_app_secret,
    COUPANG_ACCESS_KEY: a.coupang_access_key || '',
    COUPANG_SUB_ID: a.coupang_sub_id || '',
    hasCoupangSecret: !!a.coupang_secret_key,
    COUPANG_DISCLOSURE_TEMPLATE: a.coupang_disclosure_template || DEFAULT_DISCLOSURE_TEMPLATE,
    hasAnthropicKey: !!a.anthropic_api_key,
    hasOpenaiKey: !!a.openai_api_key,
    NAVER_CLIENT_ID: a.naver_client_id || '',
    hasNaverSecret: !!a.naver_client_secret,
  });
});

app.post('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
  const {
    THREADS_APP_ID,
    THREADS_APP_SECRET,
    THREADS_REDIRECT_URI,
    COUPANG_ACCESS_KEY,
    COUPANG_SECRET_KEY,
    COUPANG_SUB_ID,
    ANTHROPIC_API_KEY,
    OPENAI_API_KEY,
    CLEAR_ANTHROPIC_KEY,
    CLEAR_OPENAI_KEY,
    NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET,
    CLEAR_NAVER_KEY,
  } = req.body;

  const fields = {};
  if (THREADS_APP_ID !== undefined) fields.threads_app_id = THREADS_APP_ID;
  if (THREADS_APP_SECRET) fields.threads_app_secret = THREADS_APP_SECRET;
  if (THREADS_REDIRECT_URI !== undefined) fields.threads_redirect_uri = THREADS_REDIRECT_URI;
  if (COUPANG_ACCESS_KEY !== undefined) fields.coupang_access_key = COUPANG_ACCESS_KEY;
  if (COUPANG_SECRET_KEY) fields.coupang_secret_key = COUPANG_SECRET_KEY;
  if (COUPANG_SUB_ID !== undefined) fields.coupang_sub_id = COUPANG_SUB_ID;
  if (ANTHROPIC_API_KEY) fields.anthropic_api_key = ANTHROPIC_API_KEY;
  if (OPENAI_API_KEY) fields.openai_api_key = OPENAI_API_KEY;
  if (CLEAR_ANTHROPIC_KEY) fields.anthropic_api_key = null;
  if (CLEAR_OPENAI_KEY) fields.openai_api_key = null;
  if (NAVER_CLIENT_ID !== undefined) fields.naver_client_id = NAVER_CLIENT_ID;
  if (NAVER_CLIENT_SECRET) fields.naver_client_secret = NAVER_CLIENT_SECRET;
  if (CLEAR_NAVER_KEY) {
    fields.naver_client_id = null;
    fields.naver_client_secret = null;
  }

  updateAccount(req.account.id, fields);
  res.json({ ok: true });
});

app.post('/api/accounts/:accountId/disclosure-template', requireAccount, (req, res) => {
  const { template } = req.body;
  if (!template || !template.includes('{link}')) {
    return res.status(400).json({ error: '템플릿에는 {link} 자리표시자가 반드시 포함되어야 합니다' });
  }
  updateAccount(req.account.id, { coupang_disclosure_template: template });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Threads 스케줄러 서버 http://localhost:${PORT}`);
  startPublishJob();
  startInsightsJob();
  startAutopilotJob();
});
