'use strict';
// dev 0079f189 (2026-11-05): day caps count every live status and in-flight slots, a slot records why it got
// no video, posted videos keep their length, and video sources go first while the video cap allows one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real SQLite in a throwaway data dir - never the live db/scheduler.db.
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-videomix-'));
process.env.PUBLIC_BASE_URL = 'https://me2.test';

const { db } = require('../src/infra/db');
const ap = require('../src/content/accountPersonas');
const slots = require('../src/publish/slots');
const mix = require('../src/autopilot/accountMix');
const runner = require('../src/autopilot/runner');
const { recordPublishedVideoDuration } = require('../src/publish/publishQueue');
const { mp4DurationSec, videoUrlOfPost, postVideoDurationSec } = require('../src/threads/videoDuration');
const { sortMaterials } = require('../src/autopilot/materials');
const { encodeMediaBundle } = require('../src/threads/mediaBundle');
const { UPLOADS_DIR } = require('../src/config/paths');

assert.ok(process.env.ME2_DATA_DIR.startsWith(os.tmpdir()), 'test DB lives in tmp');
for (const id of [1, 2, 3, 4, 10, 11, 13, 14])
  db.prepare('INSERT OR IGNORE INTO accounts (id,label) VALUES (?,?)').run(id, `acct${id}`);

const LIVE = { 1: 'acct-home-keeper', 2: 'acct-newlywed-cat', 3: 'acct-busan-gut' };
function pin(extra = {}) {
  ap.setAccountPersonaConfig({
    accounts: LIVE,
    dailyPostsMin: 10,
    dailyPostsMax: 10,
    maxLinkedPerDay: 5,
    maxDailyPerDay: 3,
    maxDailyPerDayByAccount: { 2: 1 },
    maxVideoPerDay: 2,
    ...extra,
  });
}
function insert(accountId, { at, status = 'pending', mode = null, link = null, video = null, image = null }) {
  return Number(
    db
      .prepare(
        `INSERT INTO posts (account_id,text,link,scheduled_at,status,content_mode,video_url,image_url) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(accountId, 't', link, at, status, mode, video, image).lastInsertRowid
  );
}
const clear = () => db.prepare('DELETE FROM posts').run();
const DAY = '2026-11-03';
const at = h => new Date(Date.parse(`${DAY}T00:00:00+09:00`) + h * 3600000).toISOString();

// Minimal MP4: ftyp + moov/mvhd (version 0, timescale 1000, duration 12345 -> 12.35 s).
function writeMp4(file, { version = 0, timescale = 1000, duration = 12345 } = {}) {
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(8 + payload.length, 0);
    b.write(type, 4, 'latin1');
    payload.copy(b, 8);
    return b;
  };
  let mvhd;
  if (version === 1) {
    mvhd = Buffer.alloc(32 + 80);
    mvhd[0] = 1;
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    mvhd = Buffer.alloc(20 + 80);
    mvhd.writeUInt32BE(timescale, 12);
    mvhd.writeUInt32BE(duration, 16);
  }
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(64));
  fs.writeFileSync(file, Buffer.concat([ftyp, mdat, box('moov', Buffer.concat([box('mvhd', mvhd)]))]));
}

test('migration: posts has nullable video_skip_reason and video_duration_sec', () => {
  const cols = db.prepare('PRAGMA table_info(posts)').all();
  const reason = cols.find(c => c.name === 'video_skip_reason');
  const dur = cols.find(c => c.name === 'video_duration_sec');
  assert.ok(reason && dur);
  assert.equal(reason.notnull, 0);
  assert.equal(dur.notnull, 0);
  assert.equal(dur.type, 'REAL');
});

test('day caps count publishing (and any live status), not failed', () => {
  pin();
  clear();
  insert(1, { at: at(9), status: 'posted', mode: 'daily' });
  insert(1, { at: at(10), status: 'publishing', mode: 'daily' }); // 8680 at the moment 8704 was decided
  insert(1, { at: at(11), status: 'failed', mode: 'daily' });
  insert(1, { at: at(12), status: 'publishing', video: 'https://x/a.mp4' });
  insert(1, { at: at(13), status: 'failed', video: 'https://x/b.mp4' });
  assert.deepEqual(mix.dayMix(1, DAY), { linked: 0, plain: 1, daily: 2 });
  assert.equal(slots.countScheduledForDay(1, DAY), 3);
  assert.equal(mix.videoPostsOnDay(1, at(14)), 1);
  clear();
});

test('home_tempick_ case: the 4th daily is refused while the 3rd is publishing', () => {
  pin({ maxDailyPerDayByAccount: {} }); // account 1 had 3/day on 11/03
  clear();
  insert(1, { at: at(0.5), status: 'posted', mode: 'daily' });
  insert(1, { at: at(1), status: 'posted', mode: 'daily' });
  insert(1, { at: at(2), status: 'publishing', mode: 'daily' });
  for (let h = 3; h < 10; h++) insert(1, { at: at(h), status: 'posted' });
  assert.notEqual(mix.slotKind(1, at(22)), 'daily');
  assert.ok(mix.capRecheck(1, at(22), { daily: true }).daily);
  clear();
});

test('in-flight reservations: two generations of one account-day see each other', () => {
  pin();
  clear();
  for (let h = 0; h < 3; h++) insert(2, { at: at(h), status: 'pending' });
  assert.equal(mix.slotKind(2, at(3)), 'daily'); // 4th post -> the one daily of chi_chi1200
  const first = mix.reserveSlot(2, at(3), 'daily');
  assert.equal(mix.dayMix(2, DAY).daily, 1);
  assert.notEqual(mix.slotKind(2, at(4)), 'daily', 'second concurrent slot is not daily too');
  // Right before insert, the first slot does not count itself; a second one would be refused.
  assert.equal(mix.capRecheck(2, at(3), { daily: true, own: [first] }).daily, null);
  const second = mix.reserveSlot(2, at(4), 'daily');
  assert.match(mix.capRecheck(2, at(4), { daily: true, own: [second] }).daily, /한도 1\/1/);
  second.release();
  first.release();
  first.release(); // idempotent
  assert.equal(mix.dayMix(2, DAY).daily, 0);
  // Video reservations count toward maxVideoPerDay (2 here).
  const v1 = mix.reserveSlot(2, at(5), 'video');
  insert(2, { at: at(6), status: 'pending', image: encodeMediaBundle([{ type: 'VIDEO', url: 'https://x/v.mp4' }]) });
  assert.equal(mix.videoAllowed(2, at(7)), false);
  assert.equal(mix.capRecheck(2, at(5), { video: true, own: [v1] }).video, null);
  v1.release();
  assert.equal(mix.videoAllowed(2, at(7)), true);
  assert.equal(mix.videoAllowed(4, at(7)), true, 'customer accounts unaffected');
  clear();
});

test('saveAutopilotPost: guard re-check skips the insert; reason/duration land on the row', () => {
  pin();
  clear();
  const skipped = runner.saveAutopilotPost({
    accountId: 2,
    text: '오늘은 고양이가 택배 상자에서 안 나옴',
    scheduledAt: at(5),
    contentMode: 'daily',
    guard: () => '일상 글 하루 한도 1/1',
  });
  assert.deepEqual(skipped, { skipped: '일상 글 하루 한도 1/1' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 0);
  const a = runner.saveAutopilotPost({
    accountId: 2,
    text: '이미지 글',
    imageUrl: 'https://x/a.jpg',
    scheduledAt: at(6),
    contentMode: 'product',
    videoSkipReason: '소재에 영상 없음',
    guard: () => null,
  });
  const b = runner.saveAutopilotPost({
    accountId: 2,
    text: '영상 글',
    videoUrl: 'https://me2.test/uploads/v.mp4',
    scheduledAt: at(7),
    contentMode: 'product',
    videoDurationSec: 14.5,
  });
  const rows = db.prepare('SELECT id,video_skip_reason r,video_duration_sec d FROM posts ORDER BY id').all();
  assert.deepEqual(
    rows.map(r => [r.id, r.r, r.d]),
    [
      [a.id, '소재에 영상 없음', null],
      [b.id, null, 14.5],
    ]
  );
  clear();
});

test('chooseSourceMedia gives a reason for every slot that ends up without a video', async () => {
  const base = { sourceImages: ['https://x/1.jpg'], sourceUrl: 'https://www.threads.com/@a/post/1', mode: 'recipe' };
  const noVideo = await runner.chooseSourceMedia({ ...base, sourceVideos: [] }, { allowVideo: true, accountId: 1 });
  assert.equal(noVideo.videoSkipReason, '소재에 영상 없음');
  assert.equal(noVideo.imageUrl, 'https://x/1.jpg');
  const capped = await runner.chooseSourceMedia(
    { ...base, sourceVideos: ['https://x/v.mp4'] },
    { allowVideo: false, accountId: 1, capReason: '오늘 영상 한도 8/8' }
  );
  assert.equal(capped.videoSkipReason, '오늘 영상 한도 8/8');
  const noUrl = await runner.chooseSourceMedia(
    { ...base, sourceUrl: null, sourceVideos: ['https://x/v.mp4'] },
    { allowVideo: true, accountId: 1 }
  );
  assert.equal(noUrl.videoSkipReason, '영상 원본 주소 없음');
  const customer = await runner.chooseSourceMedia({ ...base, sourceVideos: [] }, null);
  assert.equal(customer.videoSkipReason, '소재에 영상 없음');
});

test('video length: mvhd v0/v1 parsed, bundle VIDEO url resolved, saved at publish only when missing', () => {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const f0 = path.join(UPLOADS_DIR, 'threads-test-v0.mp4');
  const f1 = path.join(UPLOADS_DIR, 'threads-test-v1.mp4');
  writeMp4(f0);
  writeMp4(f1, { version: 1, timescale: 90000, duration: 90000 * 31 });
  assert.equal(mp4DurationSec(f0), 12.35);
  assert.equal(mp4DurationSec(f1), 31);
  const bundle = encodeMediaBundle([
    { type: 'IMAGE', url: 'https://x/1.jpg' },
    { type: 'VIDEO', url: 'https://other.trycloudflare.com/uploads/threads-test-v1.mp4' },
  ]);
  assert.equal(videoUrlOfPost({ image_url: bundle }), 'https://other.trycloudflare.com/uploads/threads-test-v1.mp4');
  assert.equal(postVideoDurationSec({ image_url: bundle }, UPLOADS_DIR, { ffprobe: false }), 31);
  assert.equal(postVideoDurationSec({ video_url: 'https://cdn.example/x.mp4' }, UPLOADS_DIR, { ffprobe: false }), null);

  clear();
  const id = insert(1, { at: at(9), status: 'posted', video: 'https://me2.test/uploads/threads-test-v0.mp4' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  assert.equal(recordPublishedVideoDuration(post, UPLOADS_DIR), 12.35);
  assert.equal(db.prepare('SELECT video_duration_sec d FROM posts WHERE id=?').get(id).d, 12.35);
  // Already known (recorded at reservation): left alone.
  assert.equal(recordPublishedVideoDuration({ ...post, video_duration_sec: 9 }, UPLOADS_DIR), null);
  // Image post or missing file: nothing, never throws.
  assert.equal(recordPublishedVideoDuration({ id, image_url: 'https://x/1.jpg' }, UPLOADS_DIR), null);
  assert.equal(recordPublishedVideoDuration({ id, video_url: 'https://me2.test/uploads/gone.mp4' }, UPLOADS_DIR), null);
  clear();
});

test('materials: preferVideo puts every video source ahead, score still orders each group', () => {
  const longRecipe = { url: 'u1', text: '레시피 '.repeat(20) + '양념 큰술 비밀 진짜 추천', imageCount: 1 };
  const video = { url: 'u2', text: '이거 진짜 편함 매일 씀', hasVideo: true };
  const video2 = { url: 'u3', text: '짧은 영상 소재', videoCount: 1 };
  const plain = { url: 'u4', text: '그냥 일상 글 하나 적어봄' };
  const off = sortMaterials([plain, video2, longRecipe, video]);
  assert.equal(off[0], longRecipe, 'without preferVideo the score alone decides');
  const on = sortMaterials([plain, longRecipe, video2, video], { preferVideo: true });
  assert.deepEqual(new Set(on.slice(0, 2)), new Set([video, video2]));
  assert.equal(on[2], longRecipe);
});

test('runner asks for video-first materials only while the video cap allows one (owner accounts)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'runner.js'), 'utf8');
  assert.match(src, /const preferVideo = !!persona && accountMix\.videoAllowed\(account\.id, scheduledAt\)/);
  assert.match(src, /preferVideo \? \{ preferVideo: true \} : \{\}/);
  const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'materialEngine.js'), 'utf8');
  assert.match(engine, /collectQualifiedThreadsMaterials\(3, preferVideo \? \{ preferVideo: true \} : undefined\)/);
});

test.after(() => ap.setAccountPersonaConfig(null));
