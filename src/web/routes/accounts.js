'use strict';
const express = require('express');
const crypto = require('crypto');
const {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  DEFAULT_DISCLOSURE_TEMPLATE,
  canAddThreadsAccount,
} = require('../../infra/db');
const threadsApi = require('../../threads/threadsApi');
const { expiryIso } = require('../../threads/tokenRefresh');
const { requireAccount } = require('../middleware');

const router = express.Router();

// ---------- 계정 관리 ----------
router.get('/api/accounts', (req, res) => {
  res.json(listAccounts(req.currentUser.id));
});

router.post('/api/accounts', (req, res) => {
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

router.put('/api/accounts/:accountId', requireAccount, (req, res) => {
  const { label } = req.body;
  if (label !== undefined) updateAccount(req.account.id, { label: label.trim() });
  res.json({ ok: true });
});

router.delete('/api/accounts/:accountId', requireAccount, (req, res) => {
  deleteAccount(req.account.id);
  res.json({ ok: true });
});

// ---------- 자동발행(오토파일럿) ----------
router.get('/api/accounts/:accountId/autopilot', requireAccount, (req, res) => {
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
router.post('/api/accounts/:accountId/autopilot/youtube-settings', requireAccount, (req, res) => {
  const { enabled, order } = req.body || {};
  const allowedOrders = ['relevance', 'viewCount', 'date'];
  updateAccount(req.account.id, {
    autopilot_youtube_source_enabled: enabled ? 1 : 0,
    autopilot_youtube_order: allowedOrders.includes(order) ? order : 'relevance',
  });
  res.json({ ok: true });
});

// 완전자동화의 "업로드 영상 프레임 자동 사용" ON/OFF 저장
router.post('/api/accounts/:accountId/autopilot/frame-media-settings', requireAccount, (req, res) => {
  const { enabled } = req.body || {};
  updateAccount(req.account.id, { autopilot_frame_media_enabled: enabled ? 1 : 0 });
  res.json({ ok: true });
});

router.post('/api/accounts/:accountId/autopilot/start', requireAccount, (req, res) => {
  // 누르자마자 하나 만들어지는 게 아니라 1분 뒤 첫 실행, 이후로는 60~75분 랜덤 간격
  const firstRunAt = new Date(Date.now() + 60 * 1000).toISOString();
  updateAccount(req.account.id, { autopilot_enabled: 1, autopilot_next_at: firstRunAt });
  res.json({ ok: true, nextAt: firstRunAt });
});

router.post('/api/accounts/:accountId/autopilot/stop', requireAccount, (req, res) => {
  updateAccount(req.account.id, { autopilot_enabled: 0 });
  res.json({ ok: true });
});

// ---------- 연결 상태 ----------
router.get('/api/accounts/:accountId/connection-status', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    connected: !!(a.threads_access_token && a.threads_user_id),
    username: a.threads_username || null,
  });
});

// ---------- OAuth ----------
// state used to be the bare accountId and the callback trusted it, so any logged-in user could
// finish OAuth with state=<someone else's accountId> and overwrite that account's Threads token
// (their autopilot would then post to the attacker's Threads, or vice versa). state now carries a
// one-time nonce bound to this session + account, and the callback re-checks ownership.
router.get('/auth/login', requireAccount, (req, res) => {
  try {
    const nonce = crypto.randomBytes(16).toString('hex');
    req.session.threadsOauth = { nonce, accountId: req.account.id, createdAt: Date.now() };
    res.redirect(threadsApi.getAuthUrl(req.account.id, `${req.account.id}.${nonce}`));
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const [accountIdRaw, nonce] = String(state || '').split('.');
    const accountId = Number(accountIdRaw);
    if (!accountId) throw new Error('콜백에 계정 정보(state)가 없습니다');
    const pending = req.session.threadsOauth;
    delete req.session.threadsOauth;
    if (
      !pending ||
      !nonce ||
      pending.nonce !== nonce ||
      Number(pending.accountId) !== accountId ||
      Date.now() - Number(pending.createdAt || 0) > 30 * 60000
    ) {
      return res
        .status(400)
        .send(
          '연결 실패: 연결 요청이 만료되었거나 올바르지 않습니다. 대시보드에서 "스레드 계정으로 연결하기"를 다시 눌러주세요.'
        );
    }
    const target = getAccount(accountId);
    if (!target || target.user_id !== req.currentUser.id)
      return res.status(403).send('연결 실패: 본인 소유의 계정만 연결할 수 있습니다');

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
      threads_token_expires_at: expiryIso(longLived.expires_in),
      threads_username: username,
    });

    res.redirect(`/?connected=1&accountId=${accountId}`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('연결 실패: ' + (err.response?.data?.error?.message || err.message));
  }
});

// ---------- 계정 설정 (App ID/Secret, 쿠팡 키, AI 키, 안내문구 템플릿) ----------
router.get('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
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
    NAVER_CLIENT_ID: a.naver_client_id || '',
    hasNaverSecret: !!a.naver_client_secret,
  });
});

router.post('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
  const {
    THREADS_APP_ID,
    THREADS_APP_SECRET,
    THREADS_REDIRECT_URI,
    COUPANG_ACCESS_KEY,
    COUPANG_SECRET_KEY,
    COUPANG_SUB_ID,
    ANTHROPIC_API_KEY,
    CLEAR_ANTHROPIC_KEY,
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
  if (CLEAR_ANTHROPIC_KEY) fields.anthropic_api_key = null;
  if (NAVER_CLIENT_ID !== undefined) fields.naver_client_id = NAVER_CLIENT_ID;
  if (NAVER_CLIENT_SECRET) fields.naver_client_secret = NAVER_CLIENT_SECRET;
  if (CLEAR_NAVER_KEY) {
    fields.naver_client_id = null;
    fields.naver_client_secret = null;
  }

  updateAccount(req.account.id, fields);
  res.json({ ok: true });
});

router.post('/api/accounts/:accountId/disclosure-template', requireAccount, (req, res) => {
  const { template } = req.body;
  if (!template || !template.includes('{link}')) {
    return res.status(400).json({ error: '템플릿에는 {link} 자리표시자가 반드시 포함되어야 합니다' });
  }
  updateAccount(req.account.id, { coupang_disclosure_template: template });
  res.json({ ok: true });
});

module.exports = router;
