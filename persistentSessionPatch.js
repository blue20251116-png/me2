const session = require('express-session');
const { db } = require('./db');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS web_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);
`);

class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess, expires_at FROM web_sessions WHERE sid=?');
    this.setStmt = db.prepare(`INSERT INTO web_sessions(sid,sess,expires_at,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expires_at=excluded.expires_at,updated_at=datetime('now')`);
    this.destroyStmt = db.prepare('DELETE FROM web_sessions WHERE sid=?');
    this.cleanupStmt = db.prepare('DELETE FROM web_sessions WHERE expires_at<=?');
  }

  _expiry(sess) {
    const raw = sess?.cookie?.expires;
    const parsed = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now() + THIRTY_DAYS_MS;
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(String(sid));
      if (!row) return process.nextTick(() => callback(null, null));
      if (Number(row.expires_at) <= Date.now()) {
        this.destroyStmt.run(String(sid));
        return process.nextTick(() => callback(null, null));
      }
      const parsed = JSON.parse(row.sess);
      return process.nextTick(() => callback(null, parsed));
    } catch (err) {
      return process.nextTick(() => callback(err));
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      this.setStmt.run(String(sid), JSON.stringify(sess), this._expiry(sess));
      return process.nextTick(() => callback(null));
    } catch (err) {
      return process.nextTick(() => callback(err));
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStmt.run(String(sid));
      return process.nextTick(() => callback(null));
    } catch (err) {
      return process.nextTick(() => callback(err));
    }
  }

  touch(sid, sess, callback = () => {}) {
    return this.set(sid, sess, callback);
  }

  cleanup() {
    try { this.cleanupStmt.run(Date.now()); } catch {}
  }
}

const store = new SQLiteSessionStore();
store.cleanup();
setInterval(() => store.cleanup(), 60 * 60 * 1000).unref?.();

function wrappedSession(options = {}) {
  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_MS,
    ...(options.cookie || {}),
  };

  // 기존 server.js의 30일 쿠키 설정을 유지하면서, 서버 재시작/재배포 뒤에도
  // 로그인 세션이 남도록 MemoryStore 대신 SQLite 영구 저장소를 강제한다.
  return session({
    ...options,
    store,
    cookie,
  });
}

Object.assign(wrappedSession, session);
wrappedSession.Store = session.Store;
wrappedSession.MemoryStore = session.MemoryStore;

require.cache[require.resolve('express-session')].exports = wrappedSession;
console.log('[SESSION] SQLite persistent store 활성화 (30일 로그인 유지)');
