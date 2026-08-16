// Node.js 내장 SQLite 모듈 사용 (Node 22.5+ 필요, 별도 네이티브 빌드 불필요)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(path.join(dbDir, 'scheduler.db'));

const DEFAULT_DISCLOSURE_TEMPLATE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n\n{link}';

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  label TEXT NOT NULL,
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
  autopilot_youtube_source_enabled INTEGER DEFAULT 1,
  autopilot_youtube_order TEXT DEFAULT 'relevance',
  autopilot_frame_media_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  product_keyword TEXT NOT NULL,
  frame_job_id TEXT,
  image_url TEXT,
  extra_image_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  use_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  link TEXT,
  image_url TEXT,
  video_url TEXT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  threads_media_id TEXT,
  posted_at TEXT,
  error_message TEXT,
  auto_comment_enabled INTEGER DEFAULT 1,
  comment_status TEXT DEFAULT 'none',
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'pending',
  plan TEXT DEFAULT 'pro',
  daily_publish_limit INTEGER DEFAULT 20,
  max_threads_accounts INTEGER DEFAULT 1,
  expires_at TEXT,
  approved_at TEXT,
  approved_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

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
  const result = { ...DEFAULT_SITE_SETTINGS, has_pexels_api_key: false };
  for (const r of rows) {
    if (r.key === 'pexels_api_key') {
      result.has_pexels_api_key = !!r.value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SITE_SETTINGS, r.key)) {
      result[r.key] = r.value;
    }
  }
  return result;
}

function updateSiteSettings(fields) {
  const allowed = [...Object.keys(DEFAULT_SITE_SETTINGS), 'pexels_api_key'];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    if (key === 'pexels_api_key' && !value) continue;
    db.prepare(
      `INSERT INTO site_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value == null ? '' : String(value).trim());
  }
}

function getPexelsApiKey() {
  return db.prepare(`SELECT value FROM site_settings WHERE key = 'pexels_api_key'`).get()?.value || '';
}

const SYSTEM_API_SETTING_KEYS = [
  'threads_app_id',
  'threads_app_secret',
  'threads_redirect_uri',
  'openai_api_key',
  'naver_client_id',
  'naver_client_secret',
  'youtube_api_key',
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
    if (['threads_app_secret', 'openai_api_key', 'naver_client_secret', 'youtube_api_key'].includes(key) && !value) continue;
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
  assignOrphanAccountsToAdmin();
}

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
  `ALTER TABLE posts ADD COLUMN extra_image_url TEXT`,
  `ALTER TABLE accounts ADD COLUMN autopilot_youtube_source_enabled INTEGER DEFAULT 1`,
  `ALTER TABLE accounts ADD COLUMN autopilot_youtube_order TEXT DEFAULT 'relevance'`,
  `ALTER TABLE accounts ADD COLUMN autopilot_frame_media_enabled INTEGER DEFAULT 0`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* 이미 있으면 무시 */ }
}

function migrateLegacySettingsToAccount() {
  const legacyRows = db.prepare('SELECT key, value FROM settings').all();
  if (!legacyRows.length) return;

  const legacy = {};
  for (const r of legacyRows) legacy[r.key] = r.value;

  const hasThreadsData = legacy.THREADS_APP_ID || legacy.THREADS_ACCESS_TOKEN;
  if (!hasThreadsData) return;

  const existingAccount = db.prepare('SELECT id FROM accounts LIMIT 1').get();
  if (existingAccount) return;

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
  db.prepare('UPDATE posts SET account_id = ? WHERE account_id IS NULL').run(newAccountId);
}
migrateLegacySettingsToAccount();

function listAccounts(userId) {
  return db
    .prepare(
      `SELECT id, label, threads_username,
              (threads_access_token IS NOT NULL) AS connected
       FROM accounts WHERE user_id = ? ORDER BY id ASC`
    )
    .all(userId);
}

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
  'autopilot_youtube_source_enabled',
  'autopilot_youtube_order',
  'autopilot_frame_media_enabled',
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

function normalizeKeyword(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordOverlapScore(a, b) {
  const wordsA = new Set(a.split(' ').filter((w) => w.length >= 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length >= 2));
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap;
}

function saveMediaSource(accountId, { productName, frameJobId, imageUrl, extraImageUrl }) {
  const keyword = normalizeKeyword(productName);
  if (!keyword || !imageUrl) return null;
  const existing = db
    .prepare('SELECT id FROM media_sources WHERE account_id = ? AND product_keyword = ?')
    .get(accountId, keyword);
  if (existing) {
    db.prepare(
      `UPDATE media_sources SET frame_job_id = ?, image_url = ?, extra_image_url = ?, created_at = datetime('now')
       WHERE id = ?`
    ).run(frameJobId || null, imageUrl, extraImageUrl || null, existing.id);
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO media_sources (account_id, product_keyword, frame_job_id, image_url, extra_image_url)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(accountId, keyword, frameJobId || null, imageUrl, extraImageUrl || null);
  return info.lastInsertRowid;
}

function findMediaSourceForProduct(accountId, productName) {
  const target = normalizeKeyword(productName);
  if (!target) return null;
  const rows = db.prepare('SELECT * FROM media_sources WHERE account_id = ?').all(accountId);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = keywordOverlapScore(target, row.product_keyword || '');
    if (score <= 0) continue;
    if (
      score > bestScore ||
      (score === bestScore && best && (row.last_used_at || '') < (best.last_used_at || ''))
    ) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function markMediaSourceUsed(id) {
  db.prepare(`UPDATE media_sources SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?`).run(
    id
  );
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
  getPexelsApiKey,
  getSystemApiSettings,
  updateSystemApiSettings,
  hasAdmin,
  createInitialAdmin,
  saveMediaSource,
  findMediaSourceForProduct,
  markMediaSourceUsed,
};
