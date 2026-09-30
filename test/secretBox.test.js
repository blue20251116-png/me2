'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-secrets-'));
process.env.ME2_DATA_DIR = dataDir;
delete process.env.ME2_SECRET_KEY;
const box = require('../src/infra/secretBox');

test('secrets round-trip, use a fresh IV each time, and create a private key file', () => {
  const a = box.encryptSecret('sk-live-123');
  const b = box.encryptSecret('sk-live-123');
  assert.match(a, /^enc:v1:/);
  assert.notEqual(a, b);
  assert.equal(box.decryptSecret(a), 'sk-live-123');
  assert.equal(fs.statSync(path.join(dataDir, 'secret.key')).mode & 0o777, 0o600);
});

test('legacy plaintext and empty values pass through unchanged', () => {
  assert.equal(box.decryptSecret('plain-token'), 'plain-token');
  assert.equal(box.encryptSecret(''), '');
  assert.equal(box.encryptSecret(null), null);
  const enc = box.encryptSecret('x');
  assert.equal(box.encryptSecret(enc), enc, 'never double-encrypts');
});

test('a tampered value reads as empty instead of crashing', () => {
  const enc = box.encryptSecret('secret');
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(box.decryptSecret(tampered), '');
});

test('setting ME2_SECRET_KEY later still reads file-key values and flags them for re-encryption', () => {
  const old = box.encryptSecret('written-before-env-key');
  process.env.ME2_SECRET_KEY = 'a-long-random-deployment-secret';
  box.resetKeyCacheForTests();
  try {
    assert.equal(box.decryptSecret(old), 'written-before-env-key');
    assert.equal(box.needsReencrypt(old), true);
    const fresh = box.encryptSecret('new');
    assert.equal(box.needsReencrypt(fresh), false);
    assert.equal(box.decryptSecret(fresh), 'new');
  } finally {
    delete process.env.ME2_SECRET_KEY;
    box.resetKeyCacheForTests();
  }
});

test('db boot migration encrypts plaintext credentials and removes legacy plaintext copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-secrets-db-'));
  const env = { ...process.env, ME2_DATA_DIR: dir, NODE_ENV: 'test' };
  const run = code =>
    execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' })
      .trim()
      .split('\n')
      .findLast(l => l.startsWith('RESULT:'))
      ?.slice(7);
  // A "legacy" database: plaintext rows written directly.
  run(`const {db}=require('./src/infra/db');
    db.prepare("INSERT INTO accounts(label,user_id,threads_access_token,coupang_secret_key) VALUES('a',1,'TOKEN','SECRET')").run();
    db.prepare("INSERT INTO system_api_settings(key,value) VALUES('youtube_api_key','YT') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    db.prepare("INSERT INTO settings(key,value) VALUES('THREADS_ACCESS_TOKEN','LEGACY')").run();
    console.log('RESULT:ok')`);
  const out = JSON.parse(
    run(`const m=require('./src/infra/db');
    const raw=m.db.prepare('SELECT threads_access_token t,coupang_secret_key c FROM accounts').get();
    const sys=m.db.prepare("SELECT value FROM system_api_settings WHERE key='youtube_api_key'").get().value;
    console.log('RESULT:'+JSON.stringify({raw,sys,acct:m.getAccount(1),yt:m.getSystemApiSettings().youtube_api_key,legacy:m.db.prepare('SELECT COUNT(*) c FROM settings').get().c}))`)
  );
  assert.match(out.raw.t, /^enc:v1:/);
  assert.match(out.raw.c, /^enc:v1:/);
  assert.match(out.sys, /^enc:v1:/);
  assert.equal(out.acct.threads_access_token, 'TOKEN');
  assert.equal(out.acct.coupang_secret_key, 'SECRET');
  assert.equal(out.yt, 'YT');
  assert.equal(out.legacy, 0);
});

test('an empty secret.key (older non-atomic write) is replaced without losing data encrypted under it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-emptykey-'));
  const env = { ...process.env, ME2_DATA_DIR: dir, NODE_ENV: 'test' };
  delete env.ME2_SECRET_KEY;
  fs.writeFileSync(path.join(dir, 'secret.key'), '');
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const b=require('./src/infra/secretBox');
       // Simulate a value written while the key file was empty (key = sha256('')).
       const crypto=require('crypto');const iv=crypto.randomBytes(12);
       const c=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('').digest(),iv);
       const ct=Buffer.concat([c.update('old-value','utf8'),c.final()]);
       const legacy='enc:v1:'+iv.toString('base64')+':'+c.getAuthTag().toString('base64')+':'+ct.toString('base64');
       const fresh=b.encryptSecret('new-value');
       console.log('RESULT:'+JSON.stringify({old:b.decryptSecret(legacy),reenc:b.needsReencrypt(legacy),fresh:b.decryptSecret(fresh),freshPrimary:!b.needsReencrypt(fresh)}));`,
    ],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }
  );
  const r = JSON.parse(
    out
      .split('\n')
      .find(l => l.startsWith('RESULT:'))
      .slice(7)
  );
  assert.deepEqual(r, { old: 'old-value', reenc: true, fresh: 'new-value', freshPrimary: true });
  const key = fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim();
  assert.ok(key.length >= 16, 'a real key replaced the empty file');
  assert.ok(
    fs.readdirSync(dir).some(f => f.startsWith('secret.key.invalid-')),
    'the bad file is kept aside'
  );
});
