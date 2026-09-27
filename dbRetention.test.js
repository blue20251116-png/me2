'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { cleanupUploads, runRetentionCleanup } = require('./dbRetention');

const HOUR = 60 * 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-retention-'));
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(path.join(uploads, 'videos', '3'), { recursive: true });
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, status TEXT, image_url TEXT, extra_image_url TEXT, video_url TEXT, created_at TEXT DEFAULT (datetime('now')))");
  return { dir, uploads, db };
}
function writeFile(file, ageHours, bytes = 1000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const t = (Date.now() - ageHours * HOUR) / 1000;
  fs.utimesSync(file, t, t);
}

test('cleanupUploads deletes old unreferenced files and keeps recent ones', () => {
  // Disk-full incident #2 (2026-09-27): db/uploads/ (imported source videos, cached images) shares
  // the Railway volume with the SQLite file and was never cleaned up automatically.
  const { uploads, db } = setup();
  writeFile(path.join(uploads, 'old-video.mp4'), 48, 5000);
  writeFile(path.join(uploads, 'videos', '3', 'old-upload.mp4'), 48, 3000);
  writeFile(path.join(uploads, 'fresh-image.jpg'), 1);
  const r = cleanupUploads(db, uploads, { maxAgeMs: 24 * HOUR });
  assert.equal(r.deleted, 2);
  assert.equal(r.freedBytes, 8000);
  assert.ok(!fs.existsSync(path.join(uploads, 'old-video.mp4')));
  assert.ok(!fs.existsSync(path.join(uploads, 'videos', '3', 'old-upload.mp4')));
  assert.ok(fs.existsSync(path.join(uploads, 'fresh-image.jpg')));
});

test('cleanupUploads never deletes a file a pending or publishing post still points to, even inside a media bundle', () => {
  const { uploads, db } = setup();
  writeFile(path.join(uploads, 'queued-video.mp4'), 72);
  writeFile(path.join(uploads, 'bundle-image.jpg'), 72);
  writeFile(path.join(uploads, 'publishing.jpg'), 72);
  writeFile(path.join(uploads, 'already-posted.mp4'), 72);
  const bundle = '__THREADS_MEDIA_BUNDLE__' + encodeURIComponent(JSON.stringify([{ type: 'IMAGE', url: 'https://app.example/uploads/bundle-image.jpg' }]));
  const ins = db.prepare('INSERT INTO posts(status,image_url,video_url) VALUES(?,?,?)');
  ins.run('pending', null, 'https://app.example/uploads/queued-video.mp4');
  ins.run('pending', bundle, null);
  ins.run('publishing', 'https://app.example/uploads/publishing.jpg', null);
  ins.run('posted', null, 'https://app.example/uploads/already-posted.mp4');
  const r = cleanupUploads(db, uploads, { maxAgeMs: 24 * HOUR });
  assert.equal(r.keptReferenced, 3);
  assert.equal(r.deleted, 1);
  assert.ok(fs.existsSync(path.join(uploads, 'queued-video.mp4')));
  assert.ok(fs.existsSync(path.join(uploads, 'bundle-image.jpg')));
  assert.ok(fs.existsSync(path.join(uploads, 'publishing.jpg')));
  assert.ok(!fs.existsSync(path.join(uploads, 'already-posted.mp4')));
});

test('cleanupUploads deletes nothing when it cannot read which files posts still need', () => {
  const { uploads } = setup();
  writeFile(path.join(uploads, 'old.mp4'), 72);
  const emptyDb = new DatabaseSync(':memory:');
  const r = cleanupUploads(emptyDb, uploads, { maxAgeMs: 24 * HOUR });
  assert.equal(r.skipped, 'posts_unreadable');
  assert.ok(fs.existsSync(path.join(uploads, 'old.mp4')));
});

test('runRetentionCleanup frees upload files first, even when the SQLite step fails (full disk)', () => {
  // On a full volume, SQLite DELETE/VACUUM throw. File cleanup needs no free space, so it must run
  // before them - otherwise a full disk could never clean itself up.
  const { uploads, db } = setup();
  writeFile(path.join(uploads, 'old.mp4'), 72);
  const failingDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') return () => { throw new Error('database or disk is full'); };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  db.exec("CREATE TABLE invocation_logs (id INTEGER PRIMARY KEY, created_at TEXT)");
  db.exec("INSERT INTO invocation_logs(created_at) VALUES (datetime('now','-10 days'))");
  const quiet = { log() {}, warn() {}, error() {} };
  assert.throws(() => runRetentionCleanup(failingDb, quiet, { uploadsDir: uploads, uploads: { maxAgeMs: 24 * HOUR } }), /disk is full/);
  assert.ok(!fs.existsSync(path.join(uploads, 'old.mp4')), 'upload file should already be gone before the SQLite step failed');
});
