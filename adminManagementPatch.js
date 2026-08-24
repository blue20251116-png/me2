require('./subscriptionBadgePatch');

const fs = require('fs');
const path = require('path');

if (!global.__ME2_ADMIN_MANAGEMENT_PATCHED__) {
  global.__ME2_ADMIN_MANAGEMENT_PATCHED__ = true;
  try {
    const serverPath = path.join(__dirname, 'server.js');
    let source = fs.readFileSync(serverPath, 'utf8');
    if (!source.includes("/api/admin/users/:id/reset-password")) {
      const marker = "// 계좌/오픈카톡/안내문구 — 회원가입 화면에 보여줄 내용을 관리자가 직접 쓰고 고칠 수 있게";
      const route = `app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {\n  const userId = Number(req.params.id);\n  const user = getUserById(userId);\n  if (!user) return res.status(404).json({ error: '회원이 없습니다' });\n  if (user.role === 'admin') return res.status(400).json({ error: '관리자 계정은 이 메뉴에서 초기화할 수 없습니다' });\n  const temporaryPassword = crypto.randomBytes(6).toString('base64url').slice(0, 10);\n  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(temporaryPassword), userId);\n  res.json({ ok: true, temporary_password: temporaryPassword });\n});\n\n`;
      if (!source.includes(marker)) throw new Error('admin route insertion marker missing');
      source = source.replace(marker, route + marker);
      fs.writeFileSync(serverPath, source, 'utf8');
      console.log('[Admin][MANAGEMENT PATCH] 회원 임시 비밀번호 초기화 API 활성화');
    }
  } catch (err) {
    console.error('[Admin][MANAGEMENT PATCH] 적용 실패:', err.message);
  }
}
