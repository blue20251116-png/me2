const path = require('path');
const fs = require('fs');

// server.js가 app을 export하지 않기 때문에 Express factory를 한 번 감싸서
// 기존 서버를 그대로 실행한 뒤, 같은 app 인스턴스에 XHS import 라우트만 추가한다.
const expressPath = require.resolve('express');
const realExpress = require('express');
let appInstance = null;

function wrappedExpress(...args) {
  appInstance = realExpress(...args);
  return appInstance;
}
Object.assign(wrappedExpress, realExpress);
require.cache[expressPath].exports = wrappedExpress;

// 기존 서버가 세션/로그인/기존 API/스케줄러를 모두 등록하고 listen까지 시작한다.
require('./server');

if (!appInstance) throw new Error('Express app 초기화에 실패했습니다.');

const { getAccount } = require('./db');
const xhsDownloader = require('./xhsDownloader');

const uploadsDir = path.join(__dirname, 'uploads');
const xhsLocks = new Set();

function requireOwnedAccount(req, res, next) {
  // server.js의 app.use(requireAuth)가 이 라우트보다 먼저 등록되어 있으므로
  // 여기 도달할 때 req.currentUser는 로그인/승인된 사용자다.
  const accountId = Number(req.query.accountId || req.body?.accountId || req.params?.accountId);
  if (!accountId) return res.status(400).json({ error: 'accountId가 필요합니다' });
  const account = getAccount(accountId);
  if (!account) return res.status(404).json({ error: '존재하지 않는 계정입니다' });
  if (!req.currentUser || account.user_id !== req.currentUser.id) {
    return res.status(403).json({ error: '본인 소유의 계정만 이용할 수 있습니다' });
  }
  req.account = account;
  next();
}

function publicBaseUrl(req, account) {
  if (account?.threads_redirect_uri) {
    try {
      const u = new URL(account.threads_redirect_uri);
      return `${u.protocol}//${u.host}`;
    } catch {}
  }
  return `${req.protocol}://${req.get('host')}`;
}

appInstance.get('/api/xhs/status', requireOwnedAccount, async (req, res) => {
  const available = await xhsDownloader.checkAvailable();
  res.json({ available });
});

appInstance.post('/api/xhs/import', requireOwnedAccount, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: '샤오홍슈 URL을 입력해주세요.' });

  if (xhsLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 영상을 가져오는 중입니다. 완료 후 다시 시도해주세요.' });
  }

  const available = await xhsDownloader.checkAvailable();
  if (!available) {
    return res.status(503).json({ error: '현재 서버에 샤오홍슈 영상 가져오기 도구(yt-dlp)가 설치되지 않았습니다.' });
  }

  xhsLocks.add(req.account.id);
  try {
    const outputDir = path.join(uploadsDir, 'videos', String(req.account.id));
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const result = await xhsDownloader.downloadVideo({ url, outputDir });
    const base = publicBaseUrl(req, req.account);
    const publicUrl = `${base}/uploads/videos/${req.account.id}/${encodeURIComponent(result.filename)}`;

    res.json({
      success: true,
      filename: result.filename,
      url: publicUrl,
      mediaType: 'video',
      size: result.size,
      sourceUrl: result.sourceUrl,
    });
  } catch (err) {
    console.error(`[XHS import] account #${req.account.id}:`, err.message);
    res.status(422).json({ error: err.message || '샤오홍슈 영상을 가져오지 못했습니다.' });
  } finally {
    xhsLocks.delete(req.account.id);
  }
});

console.log('[XHS] 샤오홍슈/RedNote 영상 가져오기 API 활성화');
