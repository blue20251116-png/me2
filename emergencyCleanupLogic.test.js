'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The /admin/emergency-cleanup route in server.js is plain fs walking logic behind an
// ADMIN_PASSWORD-gated query param, deliberately mounted before the session middleware so
// it still works even when SQLite disk I/O is failing. This test exercises that walk logic
// in isolation (mirroring it exactly) against a throwaway temp directory - it never touches
// the real db/uploads dir, and confirms only stale files are matched/deleted while recent
// files and unrelated directories are left alone.
function walkAndMaybeDelete(dir, { olderThanDays = 3, wipeAll = false, confirm = false } = {}) {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let scanned = 0, matched = 0, deleted = 0, freedBytes = 0;
  const errors = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { errors.push(e.message); return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      scanned++;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { errors.push(e.message); continue; }
      if (!wipeAll && stat.mtimeMs >= cutoff) continue;
      matched++;
      freedBytes += stat.size;
      if (confirm) { try { fs.unlinkSync(full); deleted++; } catch (e) { errors.push(e.message); } }
    }
  }
  walk(dir);
  return { scanned, matched, deleted, freedBytes, errors };
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uptest-'));
  fs.writeFileSync(path.join(tmp, 'old.jpg'), 'x'.repeat(1000));
  fs.utimesSync(path.join(tmp, 'old.jpg'), new Date(Date.now() - 10 * 86400000), new Date(Date.now() - 10 * 86400000));
  fs.writeFileSync(path.join(tmp, 'new.jpg'), 'y'.repeat(2000));
  fs.mkdirSync(path.join(tmp, 'videos', '5'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'videos', '5', 'old.mp4'), 'z'.repeat(3000));
  fs.utimesSync(path.join(tmp, 'videos', '5', 'old.mp4'), new Date(Date.now() - 10 * 86400000), new Date(Date.now() - 10 * 86400000));
  return tmp;
}

test('dry run matches only stale files (top-level + nested) and deletes nothing', () => {
  const tmp = makeFixture();
  const r = walkAndMaybeDelete(tmp, { olderThanDays: 3, confirm: false });
  assert.equal(r.scanned, 3);
  assert.equal(r.matched, 2);
  assert.equal(r.deleted, 0);
  assert.ok(fs.existsSync(path.join(tmp, 'old.jpg')));
});

test('confirm=true deletes only the stale files, recent file survives', () => {
  const tmp = makeFixture();
  const r = walkAndMaybeDelete(tmp, { olderThanDays: 3, confirm: true });
  assert.equal(r.deleted, 2);
  assert.ok(fs.existsSync(path.join(tmp, 'new.jpg')), 'recent file must survive');
  assert.ok(!fs.existsSync(path.join(tmp, 'old.jpg')), 'old top-level file must be deleted');
  assert.ok(!fs.existsSync(path.join(tmp, 'videos', '5', 'old.mp4')), 'old nested file must be deleted');
});

test('wipeAll=true deletes every file regardless of age', () => {
  const tmp = makeFixture();
  const r = walkAndMaybeDelete(tmp, { wipeAll: true, confirm: true });
  assert.equal(r.deleted, 3);
  assert.ok(!fs.existsSync(path.join(tmp, 'new.jpg')));
});
