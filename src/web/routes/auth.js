'use strict';
const { PUBLIC_DIR } = require('../../config/paths');
const express = require('express');
const path = require('path');
const {
  createUser,
  getUserByEmail,
  getUserById,
  getTodayUsage,
  countAccountsForUser,
  getSiteSettings,
  hasAdmin,
  createInitialAdmin,
} = require('../../infra/db');
const { hashPassword, verifyPassword } = require('../auth');

const router = express.Router();

router.get('/admin-setup.html', (req, res) => {
  if (hasAdmin()) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'admin-setup.html'));
});

router.get('/api/auth/admin-setup-status', (req, res) => {
  res.json({ needsSetup: !hasAdmin() });
});

router.post('/api/auth/setup-admin', (req, res, next) => {
  if (hasAdmin()) return res.status(409).json({ error: '이미 관리자 계정이 설정되어 있습니다' });
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '관리자 이메일과 비밀번호가 필요합니다' });
  if (String(password).length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상으로 설정해주세요' });
  try {
    const id = createInitialAdmin(String(email).trim().toLowerCase(), hashPassword(password), name);
    // Same session-fixation guard as /api/auth/login: never elevate a pre-existing session id.
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = Number(id);
      req.session.save(err => (err ? next(err) : res.json({ ok: true, role: 'admin' })));
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 결제 안내(계좌/오픈카톡/문구) — 로그인 전에도 회원가입 화면에서 봐야 하므로 공개
router.get('/api/site-settings', (req, res) => {
  res.json(getSiteSettings());
});

router.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호가 필요합니다' });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (getUserByEmail(normalizedEmail)) return res.status(400).json({ error: '이미 가입된 이메일입니다' });
  try {
    createUser(normalizedEmail, hashPassword(password), name);
    res.json({ ok: true, message: '가입 신청 완료 — 관리자 승인 후 이용 가능합니다' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/auth/login', require('../loginRateLimit'), (req, res, next) => {
  const { email, password } = req.body || {};
  // getUserByEmail is case-insensitive and prefers an exact-case match, so legacy mixed-case rows
  // keep working.
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
  }
  const isExpired = user.expires_at && new Date(user.expires_at) < new Date();
  const effectiveStatus = user.status === 'active' && isExpired ? 'expired' : user.status;
  if (effectiveStatus !== 'active') {
    return res.status(403).json({ error: '로그인할 수 없는 계정 상태입니다', status: effectiveStatus });
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.save(err => (err ? next(err) : res.json({ ok: true, role: user.role })));
  });
});

router.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/api/auth/me', (req, res) => {
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

module.exports = router;
