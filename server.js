require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
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
} = require('./db');
const { hashPassword, verifyPassword, requireAuth, requireAdmin } = require('./auth');
const threadsApi = require('./threadsApi');
const { scrapeProduct } = require('./scraper');
const coupangApi = require('./coupangApi');
const { generateCaption, suggestKeyword, suggestKeywordCandidates } = require('./aiCaption');
const { generateScene, generateLifestyleImage } = require('./aiImage');
const { rankKeywordsByTrend } = require('./naverTrends');
const { startPublishJob, startInsightsJob, startAutopilotJob } = require('./scheduler');

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

app.use(express.static(path.join(__dirname, 'public'))); // index.html(대시보드)은 인증 통과 후에만

const ALLOWED_MEDIA_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/mp4|video\/quicktime)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
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
  });
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
  const url = `${getPublicBaseUrl(req, req.account)}/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  res.json({ url, filename: req.file.filename, mediaType });
});

app.delete('/api/upload-media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // 경로 조작 방지
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------- AI로 스레드 본문 자동 생성 ----------
app.post('/api/generate-caption', requireAccount, async (req, res) => {
  const { productName, price, target } = req.body;
  if (!productName) return res.status(400).json({ error: 'productName이 필요합니다' });
  try {
    const texts = await generateCaption(req.account.id, { productName, price, target });
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
  const { text, link, image_url, video_url, scheduled_at, auto_comment_enabled } = req.body;
  if (!text || !scheduled_at) {
    return res.status(400).json({ error: 'text와 scheduled_at은 필수입니다' });
  }
  const info = db
    .prepare(
      `INSERT INTO posts (account_id, text, link, image_url, video_url, scheduled_at, auto_comment_enabled, comment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.account.id,
      text,
      link || null,
      image_url || null,
      video_url || null,
      scheduled_at,
      auto_comment_enabled === false ? 0 : 1,
      link ? 'pending' : 'none'
    );
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
