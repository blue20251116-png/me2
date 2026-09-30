'use strict';
const { PUBLIC_DIR } = require('../../config/paths');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
  db,
  getUserById,
  listUsers,
  approveUser,
  setUserStatus,
  extendUserExpiry,
  getSiteSettings,
  updateSiteSettings,
  getSystemApiSettings,
  updateSystemApiSettings,
} = require('../../infra/db');
const { hashPassword, requireAdmin } = require('../auth');

const router = express.Router();

router.get('/api/admin/automation-health', requireAdmin, (req, res) => {
  const { budgetState } = require('../../infra/automationState');
  const states = db.prepare('SELECT * FROM automation_state ORDER BY account_id').all();
  const posts = db.prepare('SELECT status,COUNT(*) count FROM posts GROUP BY status').all();
  const comments = db
    .prepare("SELECT comment_status status,COUNT(*) count FROM posts WHERE status='posted' GROUP BY comment_status")
    .all();
  const review = db
    .prepare(
      "SELECT id,account_id,status,comment_status,error_message,comment_error_message FROM posts WHERE error_message LIKE '%REVIEW%' OR error_message LIKE '%OUTCOME_UNKNOWN%' OR comment_error_message LIKE '%OUTCOME_UNKNOWN%' ORDER BY id DESC LIMIT 50"
    )
    .all();
  res.set('Cache-Control', 'no-store');
  res.json({ states, posts, comments, review, budget: budgetState(), uptimeSec: Math.floor(process.uptime()) });
});

router.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
router.get('/admin.html', requireAdmin, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

router.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(listUsers().map(u => ({ ...u, password_hash: undefined })));
});

router.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  approveUser(Number(req.params.id), req.currentUser.id);
  res.json({ ok: true });
});

router.post('/api/admin/users/:id/suspend', requireAdmin, (req, res) => {
  setUserStatus(Number(req.params.id), 'suspended');
  res.json({ ok: true });
});

router.post('/api/admin/users/:id/unsuspend', requireAdmin, (req, res) => {
  setUserStatus(Number(req.params.id), 'active');
  res.json({ ok: true });
});

router.post('/api/admin/users/:id/grant', requireAdmin, (req, res) => {
  const days = Number(req.body?.days) || 30;
  const newExpiry = extendUserExpiry(Number(req.params.id), days);
  res.json({ ok: true, expires_at: newExpiry });
});

router.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: '회원이 없습니다' });
  if (user.role === 'admin') return res.status(400).json({ error: '관리자 계정은 이 메뉴에서 초기화할 수 없습니다' });
  const temporaryPassword = crypto.randomBytes(6).toString('base64url').slice(0, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(temporaryPassword), userId);
  res.json({ ok: true, temporary_password: temporaryPassword });
});

// 계좌/오픈카톡/안내문구 — 회원가입 화면에 보여줄 내용을 관리자가 직접 쓰고 고칠 수 있게
router.get('/api/admin/site-settings', requireAdmin, (req, res) => {
  res.json(getSiteSettings());
});

router.post('/api/admin/site-settings', requireAdmin, (req, res) => {
  updateSiteSettings(req.body || {});
  res.json({ ok: true });
});

// 서비스 전체가 공용으로 사용하는 API 설정 — 관리자 전용.
// secret 값 자체는 GET 응답으로 절대 돌려주지 않는다.
router.get('/api/admin/system-api-settings', requireAdmin, (req, res) => {
  const s = getSystemApiSettings();
  res.json({
    threads_app_id: s.threads_app_id || '',
    threads_redirect_uri: s.threads_redirect_uri || '',
    naver_client_id: s.naver_client_id || '',
    has_threads_app_secret: !!s.threads_app_secret,
    has_anthropic_api_key: !!s.anthropic_api_key,
    has_naver_client_secret: !!s.naver_client_secret,
    has_youtube_api_key: !!s.youtube_api_key,
  });
});

router.post('/api/admin/system-api-settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  updateSystemApiSettings({
    threads_app_id: body.threads_app_id,
    threads_app_secret: body.threads_app_secret,
    threads_redirect_uri: body.threads_redirect_uri,
    anthropic_api_key: body.anthropic_api_key,
    naver_client_id: body.naver_client_id,
    naver_client_secret: body.naver_client_secret,
    youtube_api_key: body.youtube_api_key,
  });
  res.json({ ok: true });
});

module.exports = router;
