'use strict';
const session = require('express-session');
const { db } = require('./db');
db.exec('CREATE TABLE IF NOT EXISTS login_sessions(sid TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_ms INTEGER NOT NULL)');
class SQLiteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row=db.prepare('SELECT payload,expires_ms FROM login_sessions WHERE sid=?').get(sid);
      if (!row || row.expires_ms<=Date.now()) { this.destroy(sid,()=>{}); return cb(null,null); }
      cb(null,JSON.parse(row.payload));
    } catch(err) { cb(err); }
  }
  set(sid,value,cb=()=>{}) {
    try {
      const expires=value.cookie?.expires?Date.parse(value.cookie.expires):Date.now()+30*86400000;
      db.prepare('INSERT INTO login_sessions VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET payload=excluded.payload,expires_ms=excluded.expires_ms')
        .run(sid,JSON.stringify(value),expires);
      cb();
    } catch(err) { cb(err); }
  }
  destroy(sid,cb=()=>{}) { try { db.prepare('DELETE FROM login_sessions WHERE sid=?').run(sid); cb(); } catch(err) { cb(err); } }
  touch(sid,value,cb=()=>{}) {
    try { db.prepare('UPDATE login_sessions SET expires_ms=? WHERE sid=?').run(value.cookie?.expires?Date.parse(value.cookie.expires):Date.now()+30*86400000,sid);cb(); }
    catch(err) { cb(err); }
  }
}
const cleanup=setInterval(()=>{try {db.prepare('DELETE FROM login_sessions WHERE expires_ms<=?').run(Date.now());}catch{}},3600000);
cleanup.unref();
module.exports = SQLiteSessionStore;
