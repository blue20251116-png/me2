'use strict';
const { UPLOADS_DIR } = require('../../config/paths');
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db } = require('../../infra/db');

const router = express.Router();

// Railway's platform-level healthcheck gates ALL traffic to this deployment: while this returns
// non-2xx, Railway refuses to route anything at all (not even the emergency-cleanup route below),
// so this must never fail for a reason a request to this very app can't fix on its own. It used
// to fail (503) whenever SQLite was unreachable (e.g. a full disk) - which is exactly the
// situation the emergency-cleanup route below exists to recover from, so the old healthz was
// blocking access to its own fix. This now always returns 200 and just reports dbOk for
// diagnostics; DB-dependent routes still fail on their own if the DB is actually down.
router.get('/healthz', (req,res)=>{
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({ ok: true, dbOk });
});

// 비상 디스크 정리: 디스크가 가득 차면 SQLite(DB/세션) 전체가 죽어서 로그인조차 안 되므로,
// DB/세션을 전혀 거치지 않는(=session 미들웨어보다 앞에 등록된) 순수 파일시스템 라우트로 둔다.
// db/uploads 폴더(이미지·영상)만 대상이며 DB 파일이나 .env의 API 키는 이 경로에서 아예 건드리지 않는다.
// 로그인 비밀번호와는 무관한 전용 키(CLEANUP_KEY 환경변수)로만 동작하며, 실제 삭제는 화면의
// 버튼을 눌러 POST를 보낼 때만 실행된다 (GET은 URL만 열어도 항상 미리보기만 보여줌 - 링크
// 미리보기 봇 등이 실수로 눌러도 안전).
function emergencyCleanupKeyValid(req) {
  // trim: a stray space/newline pasted into the Railway variable or the URL must not lock the owner out.
  const provided = String(req.query.key || req.body?.key || '').trim();
  const expected = String(process.env.CLEANUP_KEY || '').trim();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function emergencyCleanupScan({ olderThanDays = 3, wipeAll = false, confirm = false } = {}) {
  const emergencyUploadsDir = UPLOADS_DIR;
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let scanned = 0, matched = 0, deleted = 0, freedBytes = 0;
  const errors = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { errors.push(`${dir}: ${e.message}`); return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      scanned++;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { errors.push(`${full}: ${e.message}`); continue; }
      if (!wipeAll && stat.mtimeMs >= cutoff) continue;
      matched++;
      freedBytes += stat.size;
      if (confirm) {
        try { fs.unlinkSync(full); deleted++; }
        catch (e) { errors.push(`${full}: ${e.message}`); }
      }
    }
  }
  walk(emergencyUploadsDir);
  return { scanned, matched, deleted, freedBytes, errors };
}
router.get('/admin/emergency-cleanup', (req, res) => {
  if (!emergencyCleanupKeyValid(req)) return res.status(403).send('key가 올바르지 않습니다');
  const olderThanDays = Number(req.query.olderThanDays) || 3;
  const wipeAll = req.query.wipe === '1';
  const r = emergencyCleanupScan({ olderThanDays, wipeAll, confirm: false });
  // The hidden field must carry the key as-is (HTML-escaped only). It used to be encodeURIComponent'd,
  // so the browser form-encoded it a second time and the POST received "%EC%82%AD..." instead of
  // the key - any non-ASCII (e.g. Korean) CLEANUP_KEY previewed fine but the delete button always
  // answered "key가 올바르지 않습니다".
  const key = String(req.query.key).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<body style="font-family:sans-serif;padding:16px;font-size:16px;line-height:1.6">
<h3>업로드 파일 정리 (미리보기)</h3>
<p>기준: ${wipeAll ? '전체 파일' : `${olderThanDays}일보다 오래된 파일`}</p>
<p>스캔한 파일: ${r.scanned}개<br>지울 대상: ${r.matched}개<br>확보 예상 용량: ${(r.freedBytes / 1024 / 1024).toFixed(1)}MB</p>
<p style="color:#a00">DB와 .env의 API 키는 이 기능이 절대 건드리지 않습니다. 아래 버튼을 눌러야만 실제로 삭제됩니다.</p>
<form method="POST" action="/admin/emergency-cleanup">
<input type="hidden" name="key" value="${key}">
<input type="hidden" name="olderThanDays" value="${olderThanDays}">
<input type="hidden" name="wipe" value="${wipeAll ? '1' : '0'}">
<button type="submit" style="font-size:18px;padding:12px 20px;background:#c00;color:#fff;border:none;border-radius:8px">${r.matched}개 실제로 삭제하기</button>
</form>
${r.errors.length ? `<p style="color:#888">errors: ${r.errors.slice(0, 10).join(', ')}</p>` : ''}
</body>`);
});
router.post('/admin/emergency-cleanup', express.urlencoded({ extended: false }), (req, res) => {
  if (!emergencyCleanupKeyValid(req)) return res.status(403).send('key가 올바르지 않습니다');
  const olderThanDays = Number(req.body?.olderThanDays) || 3;
  const wipeAll = req.body?.wipe === '1';
  const r = emergencyCleanupScan({ olderThanDays, wipeAll, confirm: true });
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<body style="font-family:sans-serif;padding:16px;font-size:16px;line-height:1.6">
<h3>삭제 완료</h3>
<p>삭제된 파일: ${r.deleted}개<br>확보된 용량: ${(r.freedBytes / 1024 / 1024).toFixed(1)}MB</p>
${r.errors.length ? `<p style="color:#888">errors: ${r.errors.slice(0, 10).join(', ')}</p>` : ''}
</body>`);
});

module.exports = router;
