// Node.js 내장 SQLite 모듈 사용 (Node 22.5+ 필요, 별도 네이티브 빌드 불필요)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'db');
// 배포 환경에 빈 폴더가 누락되는 경우가 있어(git은 빈 폴더를 추적하지 않음) 없으면 직접 생성
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(path.join(dbDir, 'scheduler.db'));

// 기본 쿠팡파트너스 안내문구 (공정위 표기 의무 문구 포함) - {link} 자리에 실제 링크가 들어감
const DEFAULT_DISCLOSURE_TEMPLATE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n\n{link}';

db.exec(`
-- 계정 하나 = 스레드 계정 하나 + 그 계정에 딸린 쿠팡파트너스/AI 설정
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,                     -- 이 스레드 계정을 소유한 회원 (SaaS 회원별 데이터 분리용)
  label TEXT NOT NULL,                 -- 화면에 표시할 이름 (예: 홈템픽, 젠틀블루)

  threads_app_id TEXT,
  threads_app_secret TEXT,
  threads_redirect_uri TEXT,
  threads_user_id TEXT,
  threads_access_token TEXT,
  threads_token_expires_at TEXT,
  threads_username TEXT,

  coupang_access_key TEXT,
  coupang_secret_key TEXT,
  coupang_sub_id TEXT,
  coupang_disclosure_template TEXT,

  anthropic_api_key TEXT,
  openai_api_key TEXT,
  naver_client_id TEXT,
  naver_client_secret TEXT,

  autopilot_enabled INTEGER DEFAULT 0,
  autopilot_next_at TEXT,
  autopilot_last_keyword TEXT,
  autopilot_last_target TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  link TEXT,               -- 쿠팡파트너스 링크 등 첨부 링크 (댓글로 자동 등록됨)
  image_url TEXT,          -- 이미지 URL (선택)
  video_url TEXT,          -- 영상 URL (선택, image_url과 동시 사용 불가)
  scheduled_at TEXT NOT NULL,   -- ISO 문자열, 발행 예정 시각
  status TEXT NOT NULL DEFAULT 'pending', -- pending | posted | failed
  threads_media_id TEXT,   -- 발행 성공 후 스레드 미디어 ID
  posted_at TEXT,
  error_message TEXT,
  auto_comment_enabled INTEGER DEFAULT 1, -- 1: 본문 발행 후 안내문구+링크를 댓글로 자동 등록
  comment_status TEXT DEFAULT 'none',     -- none | pending | posted | failed (link 없으면 계속 none)
  comment_media_id TEXT,
  comment_posted_at TEXT,
  comment_error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS insights (
  post_id INTEGER PRIMARY KEY,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- 예전 버전(단일 계정)에서 쓰던 전역 설정 테이블. 마이그레이션 시 참고용으로만 유지.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- SaaS 회원 계정 (스레드 "account"와는 다른 개념 — 여기 "user"가 로그인하는 서비스 회원)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user',            -- user | admin
  status TEXT DEFAULT 'pending',       -- pending | active | suspended
  plan TEXT DEFAULT 'pro',
  daily_publish_limit INTEGER DEFAULT 20,
  max_threads_accounts INTEGER DEFAULT 1,
  expires_at TEXT,
  approved_at TEXT,
  approved_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AI 생성/발행 비용을 회원별로 추적하기 위한 최소 로그 (관리자 화면에서 사용량 확인용)
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,   -- 'text' (글/키워드/상황 생성) | 'image' (라이프스타일 이미지 생성)
  created_at TEXT DEFAULT (datetime('now'))
);

-- 회원가입 화면 등에 보여줄 결제 안내(계좌/오픈카톡/문구). 관리자가 admin 페이지에서 직접 수정.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 운영자 공용 API 설정. 일반 회원에게는 절대 노출하지 않고 관리자 화면에서만 관리.
CREATE TABLE IF NOT EXISTS system_api_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const DEFAULT_SITE_SETTINGS = {
  price_label: '19,900원 / 월',
  bank_info: '새마을금고 9003296753264 (예금주: 박건우)',
  open_kakao_url: '',
  tax_email: 'zsdg181@naver.com',
  payment_guide:
    '가입 신청 후 위 계좌로 입금해주세요.\n' +
    '입금 후 오픈카톡으로 "입금자명 + 스레드 아이디"를 보내주시면 확인 후 승인해드립니다.\n' +
    '현금영수증이 필요하시면 발행에 필요한 정보를 이메일로 보내주세요.',
};

function seedSiteSettingsIfEmpty() {
  for (const [key, value] of Object.entries(DEFAULT_SITE_SETTINGS)) {
    const existing = db.prepare('SELECT 1 FROM site_settings WHERE key = ?').get(key);
    if (!existing) {
      db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}
seedSiteSettingsIfEmpty();

function getSiteSettings() {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const result = { ...DEFAULT_SITE_SETTINGS };
  for (const r of rows) result[r.key] = r.value;
  return result;
}

function updateSiteSettings(fields) {
  const allowed = Object.keys(DEFAULT_SITE_SETTINGS);
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    db.prepare(
      `INSERT INTO site_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
}


// ---- 운영자 공용 API 설정 ----
const SYSTEM_API_SETTING_KEYS = [
  'threads_app_id',
  'threads_app_secret',
  'threads_redirect_uri',
  'openai_api_key',
  'naver_client_id',
  'naver_client_secret',
];

function getSystemApiSettings() {
  const rows = db.prepare('SELECT key, value FROM system_api_settings').all();
  const out = {};
  for (const key of SYSTEM_API_SETTING_KEYS) out[key] = '';
  for (const row of rows) {
    if (SYSTEM_API_SETTING_KEYS.includes(row.key)) out[row.key] = row.value || '';
  }
  return out;
}

function updateSystemApiSettings(fields) {
  for (const key of SYSTEM_API_SETTING_KEYS) {
    if (!(key in fields)) continue;
    const value = fields[key];
    // secret 입력란은 빈 값으로 보내면 기존 값을 유지한다.
    if (['threads_app_secret', 'openai_api_key', 'naver_client_secret'].includes(key) && !value) continue;
    db.prepare(
      `INSERT INTO system_api_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value == null ? '' : String(value).trim());
  }
}

function hasAdmin() {
  return !!db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get();
}

function createInitialAdmin(email, passwordHash, name) {
  if (hasAdmin()) throw new Error('이미 관리자 계정이 설정되어 있습니다');
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(
      `UPDATE users SET password_hash = ?, name = ?, role = 'admin', status = 'active', expires_at = NULL WHERE id = ?`
    ).run(passwordHash, name || '관리자', existing.id);
    assignOrphanAccountsToAdmin();
    return existing.id;
  }
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, role, status, plan, expires_at)
     VALUES (?, ?, ?, 'admin', 'active', 'pro', NULL)`
  ).run(email, passwordHash, name || '관리자');
  assignOrphanAccountsToAdmin();
  return info.lastInsertRowid;
}

// 최초 관리자 자동 생성/승격 — 회원가입 경로로는 admin이 될 수 없고, 오직 서버 환경변수로만 부트스트랩됨
function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const { hashPassword } = require('./auth');
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role !== 'admin' || existing.status !== 'active') {
      db.prepare(`UPDATE users SET role = 'admin', status = 'active' WHERE id = ?`).run(existing.id);
    }
  } else {
    db.prepare(
      `INSERT INTO users (email, password_hash, name, role, status, plan, expires_at)
       VALUES (?, ?, ?, 'admin', 'active', 'pro', NULL)`
    ).run(email, hashPassword(password), '관리자');
  }
  // 회원 시스템 도입 전에 만들어진 계정들(user_id 없음)을 관리자에게 자동으로 붙여줌
  assignOrphanAccountsToAdmin();
}

// posts에 account_id 컬럼이 없던 예전 DB를 위한 마이그레이션
const migrations = [
  `ALTER TABLE posts ADD COLUMN auto_comment_enabled INTEGER DEFAULT 1`,
  `ALTER TABLE posts ADD COLUMN comment_status TEXT DEFAULT 'none'`,
  `ALTER TABLE posts ADD COLUMN comment_media_id TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_posted_at TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_error_message TEXT`,
  `ALTER TABLE posts ADD COLUMN video_url TEXT`,
  `ALTER TABLE posts ADD COLUMN account_id INTEGER`,
  `ALTER TABLE accounts ADD COLUMN openai_api_key TEXT`,
  `ALTER TABLE accounts ADD COLUMN autopilot_enabled INTEGER DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN autopilot_next_at TEXT`,
  `ALTER TABLE accounts ADD COLUMN autopilot_last_keyword TEXT`,
  `ALTER TABLE accounts ADD COLUMN autopilot_last_target TEXT`,
  `ALTER TABLE accounts ADD COLUMN naver_client_id TEXT`,
  `ALTER TABLE accounts ADD COLUMN naver_client_secret TEXT`,
  `ALTER TABLE accounts ADD COLUMN user_id INTEGER`,
  // 캐러셀(2장) 발행 지원: 라이프스타일 이미지(image_url) + 상세페이지 사진(extra_image_url)
  `ALTER TABLE posts ADD COLUMN extra_image_url TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* 컬럼이 이미 있으면 무시 */ }
}

// ---- 예전 단일 계정(settings 테이블) 데이터를 계정 1개로 자동 이전 ----
function migrateLegacySettingsToAccount() {
  const legacyRows = db.prepare('SELECT key, value FROM settings').all();
  if (!legacyRows.length) return;

  const legacy = {};
  for (const r of legacyRows) legacy[r.key] = r.value;

  const hasThreadsData = legacy.THREADS_APP_ID || legacy.THREADS_ACCESS_TOKEN;
  if (!hasThreadsData) return;

  const existingAccount = db.prepare('SELECT id FROM accounts LIMIT 1').get();
  if (existingAccount) return; // 이미 계정이 있으면 중복 이전하지 않음

  db.prepare(
    `INSERT INTO accounts (
      label, threads_app_id, threads_app_secret, threads_redirect_uri,
      threads_user_id, threads_access_token, threads_token_expires_at,
      coupang_access_key, coupang_secret_key, coupang_sub_id, coupang_disclosure_template,
      anthropic_api_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    '기본 계정',
    legacy.THREADS_APP_ID || null,
    legacy.THREADS_APP_SECRET || null,
    legacy.THREADS_REDIRECT_URI || null,
    legacy.THREADS_USER_ID || null,
    legacy.THREADS_ACCESS_TOKEN || null,
    legacy.THREADS_TOKEN_EXPIRES_AT || null,
    legacy.COUPANG_ACCESS_KEY || null,
    legacy.COUPANG_SECRET_KEY || null,
    legacy.COUPANG_SUB_ID || null,
    legacy.COUPANG_DISCLOSURE_TEMPLATE || DEFAULT_DISCLOSURE_TEMPLATE,
    legacy.ANTHROPIC_API_KEY || null
  );

  const newAccountId = db.prepare('SELECT id FROM accounts ORDER BY id DESC LIMIT 1').get().id;
  // 계정 없이 저장된 예전 글들을 새로 만든 계정으로 연결
  db.prepare('UPDATE posts SET account_id = ? WHERE account_id IS NULL').run(newAccountId);
}
migrateLegacySettingsToAccount();

// ---- 계정 CRUD (회원별로 분리) ----
function listAccounts(userId) {
  return db
    .prepare(
      `SELECT id, label, threads_username,
              (threads_access_token IS NOT NULL) AS connected
       FROM accounts WHERE user_id = ? ORDER BY id ASC`
    )
    .all(userId);
}

// 오토파일럿/예약발행 크론이 회원 구분 없이 전체 계정을 순회해야 할 때 쓰는 시스템 전용 함수.
// API 라우트에서는 절대 쓰지 말 것 (회원별 데이터 분리를 우회하게 됨).
function listAllAccountsForSystem() {
  return db.prepare(`SELECT id FROM accounts ORDER BY id ASC`).all();
}

function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function countAccountsForUser(userId) {
  return db.prepare('SELECT COUNT(*) c FROM accounts WHERE user_id = ?').get(userId).c;
}

function createAccount(label, userId) {
  const info = db
    .prepare(`INSERT INTO accounts (label, user_id, coupang_disclosure_template) VALUES (?, ?, ?)`)
    .run(label, userId, DEFAULT_DISCLOSURE_TEMPLATE);
  return info.lastInsertRowid;
}

// 회원 시스템 도입 전에 만들어진 계정(user_id가 비어있음)을 관리자 회원에게 자동으로 귀속시킴.
// 이렇게 안 하면 회원 시스템 붙인 직후 기존에 쓰던 스레드 계정들이 아무 회원 것도 아니게 되어 사라져 보임.
function assignOrphanAccountsToAdmin() {
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`).get();
  if (!admin) return;
  db.prepare('UPDATE accounts SET user_id = ? WHERE user_id IS NULL').run(admin.id);
}

const ACCOUNT_UPDATABLE_FIELDS = [
  'label',
  'threads_app_id',
  'threads_app_secret',
  'threads_redirect_uri',
  'threads_user_id',
  'threads_access_token',
  'threads_token_expires_at',
  'threads_username',
  'coupang_access_key',
  'coupang_secret_key',
  'coupang_sub_id',
  'coupang_disclosure_template',
  'anthropic_api_key',
  'openai_api_key',
  'autopilot_enabled',
  'autopilot_next_at',
  'autopilot_last_keyword',
  'autopilot_last_target',
  'naver_client_id',
  'naver_client_secret',
];

function updateAccount(id, fields) {
  const entries = Object.entries(fields).filter(([k]) => ACCOUNT_UPDATABLE_FIELDS.includes(k));
  if (!entries.length) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE accounts SET ${setClause} WHERE id = ?`).run(...values, id);
}

function deleteAccount(id) {
  db.prepare('DELETE FROM insights WHERE post_id IN (SELECT id FROM posts WHERE account_id = ?)').run(id);
  db.prepare('DELETE FROM posts WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ---- 회원(users) 관련 함수 ----
function createUser(email, passwordHash, name) {
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)`)
    .run(email, passwordHash, name || null);
  return info.lastInsertRowid;
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

function approveUser(id, approvedBy) {
  db.prepare(
    `UPDATE users SET status = 'active', approved_at = datetime('now'), approved_by = ? WHERE id = ?`
  ).run(approvedBy, id);
}

// ---- 발행량/사용량 제한 (플랜 정책) ----
// 관리자는 요금제 제약을 받지 않음 (서비스 운영/테스트 목적 계정이라 일반 회원과 다름)
function canPublish(userId) {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COUNT(*) c FROM posts
       WHERE status = 'posted' AND posted_at >= ?
         AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
    )
    .get(startOfDay.toISOString(), userId);
  return row.c < user.daily_publish_limit;
}

function canAddThreadsAccount(userId) {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;
  return countAccountsForUser(userId) < user.max_threads_accounts;
}

function logUsage(userId, type) {
  db.prepare(`INSERT INTO usage_events (user_id, type) VALUES (?, ?)`).run(userId, type);
}

function getTodayUsage(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = db
    .prepare(`SELECT type, COUNT(*) c FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY type`)
    .all(userId, startOfDay.toISOString());
  const result = { text: 0, image: 0 };
  for (const r of rows) result[r.type] = r.c;

  const publishedToday = db
    .prepare(
      `SELECT COUNT(*) c FROM posts
       WHERE status = 'posted' AND posted_at >= ?
         AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
    )
    .get(startOfDay.toISOString(), userId).c;

  return { ...result, publishedToday };
}

function setUserStatus(id, status) {
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, id);
}

// days만큼 이용기간을 늘림 (기존 만료일이 미래면 거기서부터, 지났거나 없으면 오늘부터 카운트)
function extendUserExpiry(id, days) {
  const user = getUserById(id);
  if (!user) throw new Error('존재하지 않는 회원입니다');
  const now = new Date();
  const base =
    user.expires_at && new Date(user.expires_at) > now ? new Date(user.expires_at) : now;
  base.setDate(base.getDate() + days);
  const newExpiry = base.toISOString();
  db.prepare(`UPDATE users SET expires_at = ? WHERE id = ?`).run(newExpiry, id);
  return newExpiry;
}

// req 객체가 없는 크론(scheduler.js)에서도 이미지 절대경로를 만들 수 있게 해주는 헬퍼.
// 계정별 redirect_uri -> 서버 공용 설정 -> 환경변수 순으로 배포 주소를 추정한다.
function getPublicBaseUrlForAccount(account) {
  const shared = getSystemApiSettings();
  const candidate =
    account?.threads_redirect_uri || shared.threads_redirect_uri || process.env.THREADS_REDIRECT_URI || null;
  if (candidate) {
    try {
      const u = new URL(candidate);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

module.exports = {
  db,
  getPublicBaseUrlForAccount,
  DEFAULT_DISCLOSURE_TEMPLATE,
  listAccounts,
  listAllAccountsForSystem,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  countAccountsForUser,
  bootstrapAdmin,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  approveUser,
  setUserStatus,
  extendUserExpiry,
  canPublish,
  canAddThreadsAccount,
  logUsage,
  getTodayUsage,
  getSiteSettings,
  updateSiteSettings,
  getSystemApiSettings,
  updateSystemApiSettings,
  hasAdmin,
  createInitialAdmin,
};
