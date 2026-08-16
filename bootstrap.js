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

const { db, getAccount, listAccounts, logUsage } = require('./db');
const videoEditor = require('./videoEditor');
const threadsMediaImporter = require('./threadsMediaImporter');
const { searchThreadsMaterials } = require('./threadsMaterialSearch');
const { generateFromThreadsMaterial } = require('./threadsMaterialWriter');

// 예전 DB에도 레시피 댓글 컬럼이 확실히 있도록 보강한다.
try { db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`); } catch {}

const uploadsDir = path.join(__dirname, 'uploads');
const videoEditLocks = new Set();
const threadsImportLocks = new Set();
const threadsSearchLocks = new Set();

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

// Threads 영상 가져오기 전용 화면에서 현재 사용자의 계정 목록을 불러오기 위한 최소 API.
appInstance.get('/api/threads/accounts', (req, res) => {
  if (!req.currentUser) return res.status(401).json({ error: '로그인이 필요합니다' });
  res.json({ accounts: listAccounts(req.currentUser.id) });
});

// 쿠팡 API 없이 Threads 공개 검색 화면에서 소재 후보를 찾는다.
appInstance.get('/api/threads/material-search', requireOwnedAccount, async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: '검색어를 입력해주세요.' });
  if (threadsSearchLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 Threads 소재를 찾는 중입니다. 잠시 후 다시 시도해주세요.' });
  }
  threadsSearchLocks.add(req.account.id);
  try {
    const result = await searchThreadsMaterials(keyword, { limit: Number(req.query.limit) || 10 });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[Threads material search] account #${req.account.id}:`, err.message);
    res.status(422).json({ error: err.message || 'Threads 소재 검색에 실패했습니다.' });
  } finally {
    threadsSearchLocks.delete(req.account.id);
  }
});

// 검색된 Threads 소재를 참고해 원문 복사 없이 새 Threads 본문과(레시피면) 2/2 댓글을 만든다.
// 쿠팡 API는 전혀 사용하지 않는다.
appInstance.post('/api/threads/material-write', requireOwnedAccount, async (req, res) => {
  const keyword = String(req.body?.keyword || '').trim();
  const sourceText = String(req.body?.sourceText || '').trim();
  const mode = req.body?.mode === 'recipe' ? 'recipe' : 'product';
  if (!keyword && !sourceText) return res.status(400).json({ error: '검색어 또는 소재 내용이 필요합니다.' });
  try {
    const generated = await generateFromThreadsMaterial(req.account.id, { keyword, sourceText, mode });
    if (req.currentUser?.id) logUsage(req.currentUser.id, 'text');
    res.json({ success: true, mode, ...generated });
  } catch (err) {
    console.error(`[Threads material write] account #${req.account.id}:`, err.message);
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Threads 소재 레시피에서 만들어진 2/2 댓글까지 함께 저장하는 예약 엔드포인트.
// 일반 예약은 기존 /api/posts를 그대로 사용하고, 레시피 소재를 쓴 경우에만 프론트가 이 API를 호출한다.
appInstance.post('/api/threads/material-post', requireOwnedAccount, (req, res) => {
  const text = String(req.body?.text || '').trim();
  const scheduledAt = String(req.body?.scheduled_at || '').trim();
  const recipeCommentText = String(req.body?.recipe_comment_text || '').trim();
  if (!text || !scheduledAt) {
    return res.status(400).json({ error: '본문과 발행 예정 시각은 필수입니다.' });
  }

  const link = String(req.body?.link || '').trim() || null;
  const imageUrl = String(req.body?.image_url || '').trim() || null;
  const extraImageUrl = req.body?.video_url ? null : (String(req.body?.extra_image_url || '').trim() || null);
  const videoUrl = String(req.body?.video_url || '').trim() || null;
  const autoCommentEnabled = req.body?.auto_comment_enabled === false ? 0 : 1;
  const commentStatus = (link || recipeCommentText) && autoCommentEnabled ? 'pending' : 'none';

  const info = db.prepare(`
    INSERT INTO posts
      (account_id, text, link, image_url, extra_image_url, video_url, scheduled_at,
       auto_comment_enabled, comment_status, recipe_comment_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.account.id,
    text,
    link,
    imageUrl,
    extraImageUrl,
    videoUrl,
    scheduledAt,
    autoCommentEnabled,
    commentStatus,
    recipeCommentText || null
  );

  res.json({ success: true, id: info.lastInsertRowid });
});

// 공개 Threads 게시물 URL에서 영상 주소를 찾아 계정별 영상 폴더에 MP4로 저장한다.
appInstance.post('/api/threads/import', requireOwnedAccount, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Threads 게시물 URL을 입력해주세요.' });

  if (threadsImportLocks.has(req.account.id)) {
    return res.status(429).json({ error: '이미 Threads 영상을 가져오는 중입니다. 완료 후 다시 시도해주세요.' });
  }

  threadsImportLocks.add(req.account.id);
  try {
    const outputDir = path.join(uploadsDir, 'videos', String(req.account.id));
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const result = await threadsMediaImporter.importThreadsVideo({ url, outputDir });
    const base = publicBaseUrl(req, req.account);
    const publicUrl = `${base}/uploads/videos/${req.account.id}/${encodeURIComponent(result.filename)}`;

    res.json({
      success: true,
      filename: result.filename,
      url: publicUrl,
      mediaType: 'video',
      size: result.size,
      sourceUrl: result.sourceUrl,
      poster: result.poster || null,
      title: result.title || '',
    });
  } catch (err) {
    console.error(`[Threads import] account #${req.account.id}:`, err.message);
    res.status(422).json({ error: err.message || 'Threads 영상을 가져오지 못했습니다.' });
  } finally {
    threadsImportLocks.delete(req.account.id);
  }
});

// 직접 업로드하거나 Threads에서 이 계정 영상 폴더로 가져온 영상만 편집 가능.
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

console.log('[Threads material] 쿠팡 API 없는 Threads 소재 검색/AI 글쓰기 API 활성화');
console.log('[Threads material] 레시피 2/2 댓글 예약 저장 API 활성화');
console.log('[Threads import] 공개 Threads 영상 가져오기 API 활성화');
console.log('[Video edit] 영상 음소거/앞뒤 컷 API 활성화');
