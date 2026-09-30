'use strict';
// Fixed-window, per-IP limiter for the unauthenticated auth endpoints (in-memory: one instance).
function createRateLimit({ max, windowMs, message }) {
  const attempts = new Map();
  return function rateLimit(req, res, next) {
    const key = String(req.ip || 'unknown');
    const now = Date.now();
    if (attempts.size > 10000) for (const [ip, row] of attempts) if (row.until <= now) attempts.delete(ip);
    let row = attempts.get(key);
    if (!row || row.until <= now) {
      row = { count: 0, until: now + windowMs };
      attempts.set(key, row);
    }
    if (++row.count > max) {
      res.set('Retry-After', String(Math.ceil((row.until - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const loginRateLimit = createRateLimit({
  max: 30,
  windowMs: 15 * 60000,
  message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.',
});
const signupRateLimit = createRateLimit({
  max: 10,
  windowMs: 60 * 60000,
  message: '가입 신청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
});

module.exports = loginRateLimit;
module.exports.signupRateLimit = signupRateLimit;
module.exports.createRateLimit = createRateLimit;
