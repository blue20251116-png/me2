const crypto = require('crypto');

// bcrypt 대신 Node 내장 crypto.scrypt 사용 — 네이티브 컴파일이 필요 없어서
// 배포 환경(Railway 등)에서 better-sqlite3 때 겪었던 빌드 실패 문제를 피함
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashToCompare = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashToCompare, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 로그인 세션 유무 + 상태(active/pending/suspended/expired)를 확인하는 미들웨어.
// 통과하면 req.currentUser에 로그인한 사용자 정보를 넣어줌.
function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) {
    return respondUnauthenticated(req, res);
  }
  const { getUserById } = require('./db');
  const user = getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return respondUnauthenticated(req, res);
  }

  const isExpired = user.expires_at && new Date(user.expires_at) < new Date();
  const effectiveStatus = user.status === 'active' && isExpired ? 'expired' : user.status;

  if (effectiveStatus !== 'active') {
    return respondBlocked(req, res, effectiveStatus);
  }

  req.currentUser = user;
  next();
}

function respondUnauthenticated(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  res.redirect('/login.html');
}

const STATUS_MESSAGES = {
  pending: '관리자 승인 대기 중입니다.',
  suspended: '이용이 중지된 계정입니다.',
  expired: '이용기간이 만료되었습니다.',
};

function respondBlocked(req, res, status) {
  const message = STATUS_MESSAGES[status] || '접근할 수 없는 계정 상태입니다.';
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: message, status });
  }
  res.redirect(`/status.html?status=${status}`);
}

// 관리자 전용 라우트 보호. requireAuth 통과 이후에 붙여서 사용.
function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    }
    return res.status(403).send('관리자만 접근할 수 있습니다');
  }
  next();
}

module.exports = { hashPassword, verifyPassword, requireAuth, requireAdmin };
