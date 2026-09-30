'use strict';
// Encryption at rest for API keys and tokens stored in SQLite (AES-256-GCM).
//
// Key source, in order:
//  1. ME2_SECRET_KEY env var (recommended: keeps the key off the data volume, so a leaked DB file
//     or backup alone reveals nothing). Any string; it is hashed to 32 bytes.
//  2. <data dir>/secret.key, generated on first use (mode 600). Still protects DB dumps/backups,
//     but not a copy of the whole volume.
//
// Stored format: "enc:v1:<iv>:<tag>:<ciphertext>" (base64). Values without the prefix are legacy
// plaintext and are returned as-is, so existing rows keep working until migrated.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/paths');

const PREFIX = 'enc:v1:';
let cachedKeys = null;

// [primary, ...fallbacks]. Encryption always uses the primary; decryption tries every key, so
// setting ME2_SECRET_KEY later still reads values written with the auto-generated file key (and
// db.js re-encrypts them with the new primary at boot).
function loadKeys() {
  if (cachedKeys) return cachedKeys;
  const keys = [];
  const fromEnv = String(process.env.ME2_SECRET_KEY || '').trim();
  if (fromEnv) keys.push(crypto.createHash('sha256').update(fromEnv).digest());
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (!fromEnv && !fs.existsSync(keyFile)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      console.warn('[Secrets] ME2_SECRET_KEY 미설정 → 데이터 폴더에 암호화 키(secret.key)를 새로 만들었습니다');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  if (fs.existsSync(keyFile))
    keys.push(crypto.createHash('sha256').update(fs.readFileSync(keyFile, 'utf8').trim()).digest());
  cachedKeys = keys;
  return keys;
}

function decryptWith(key, value) {
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(value) {
  if (value == null || value === '' || isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKeys()[0], iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

// A value that can't be decrypted (wrong/lost key, corrupted row) reads as empty, so the account
// behaves as "not configured" and the user re-enters the key, instead of the app crashing.
function decryptSecret(value) {
  if (!isEncrypted(value)) return value;
  for (const key of loadKeys()) {
    try {
      return decryptWith(key, value);
    } catch {}
  }
  console.error(
    '[Secrets] 저장된 비밀값을 복호화하지 못했습니다 (암호화 키가 바뀌었거나 손상됨) - 다시 입력이 필요합니다'
  );
  return '';
}

// True for a value encrypted with a fallback key (readable, but should be re-encrypted).
function needsReencrypt(value) {
  if (!isEncrypted(value)) return false;
  try {
    decryptWith(loadKeys()[0], value);
    return false;
  } catch {
    return decryptSecret(value) !== '';
  }
}

function resetKeyCacheForTests() {
  cachedKeys = null;
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, needsReencrypt, resetKeyCacheForTests };
