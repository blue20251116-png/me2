const path = require('path');
const fs = require('fs');

// server.js가 app을 export하지 않기 때문에 Express factory를 한 번 감싸서
// 기존 서버를 그대로 실행한 뒤, 같은 app 인스턴스에 확장 라우트를 추가한다.
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
const videoEditor = require('./videoEditor');

const uploadsDir = path.join(__dirname, 'uploads');
const videoEditLocks = new Set();

function requireOwnedAccount(req, res, next) {
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

function ownVideoPath(accountId, filename) {
  const safeFilename = path.basename(String(filename || ''));
  return path.join(uploadsDir, 'videos', String(accountId), safeFilename);
}

// 직접 업로드한 계정 소유 영상만 편집 가능.
// 입력 filename은 basename만 사용하고 실제 경로는 계정별 폴더에서 서버가 직접 조립한다.
appInstance.post('/api/video/edit', requireOwnedAccount, async (req, res) => {
  const filename = path.basename(String(req.body?.filename || ''));
  if (!filename) return res.status(400).json({ error: '편집할 영상 filename이 필요합니다.' });

  const inputPath = ownVideoPath(req.account.id, filename);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: '편집할 영상 파일을 찾을 수 없습니다.' });
  }

  if (videoEditLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 영상 편집 중입니다. 완료 후 다시 시도해주세요.' });
  }

  videoEditLocks.add(req.account.id);
  try {
    const outputDir = path.join(uploadsDir, 'videos', String(req.account.id));
    const result = await videoEditor.editVideo({
      inputPath,
      outputDir,
      start: req.body?.start,
      end: req.body?.end,
      mute: req.body?.mute !== false,
    });

    const base = publicBaseUrl(req, req.account);
    const publicUrl = `${base}/uploads/videos/${req.account.id}/${encodeURIComponent(result.filename)}`;
    res.json({
      success: true,
      filename: result.filename,
      url: publicUrl,
      mediaType: 'video',
      size: result.size,
      sourceDuration: result.sourceDuration,
      start: result.start,
      end: result.end,
      duration: result.duration,
      muted: result.muted,
    });
  } catch (err) {
    console.error(`[Video edit] account #${req.account.id}:`, err.message);
    res.status(422).json({ error: err.message || '영상 편집에 실패했습니다.' });
  } finally {
    videoEditLocks.delete(req.account.id);
  }
});

console.log('[Video edit] 영상 음소거/앞뒤 컷 API 활성화');
