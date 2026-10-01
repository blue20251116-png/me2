'use strict';

// Threads long-lived tokens last 60 days. refreshLongLivedToken() existed in threadsApi.js but
// nothing ever called it, so ~60 days after connecting every publish failed with OAuthException
// 190 (non-retryable -> post marked failed) while autopilot kept generating posts that could never
// go out. This daily job refreshes any token that is at least 24h old (Meta refuses younger ones)
// and expires within REFRESH_WITHIN_DAYS.
// db/node-cron are required lazily so the pure expiry helpers stay importable (scheduler.js's vm
// test harness loads them) without opening the real SQLite database.

const REFRESH_WITHIN_DAYS = 10;
const DAY_MS = 86400000;
const TOKEN_LIFETIME_MS = 60 * DAY_MS;

// The OAuth callback historically stored expiry as a millisecond-epoch string
// (String(Date.now()+expires_in*1000)); newer rows store ISO. Date.parse() of the epoch form is
// NaN, which made the scheduler's "token expired" guard silently never fire. Accept both.
function parseTokenExpiry(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isTokenExpired(account, now = Date.now()) {
  const exp = parseTokenExpiry(account?.threads_token_expires_at);
  return exp !== null && exp <= now;
}

function needsRefresh(account, now = Date.now()) {
  if (!String(account?.threads_access_token || '').trim()) return false;
  const exp = parseTokenExpiry(account.threads_token_expires_at);
  if (exp === null) return true; // unknown expiry: refreshing is harmless and records a real one
  if (exp <= now) return false; // already expired: only a reconnect can fix it
  const issuedAt = exp - TOKEN_LIFETIME_MS;
  return exp - now <= REFRESH_WITHIN_DAYS * DAY_MS && now - issuedAt >= DAY_MS;
}

function expiryIso(expiresInSeconds, now = Date.now()) {
  const sec = Number(expiresInSeconds);
  return new Date(now + (Number.isFinite(sec) && sec > 0 ? sec * 1000 : TOKEN_LIFETIME_MS)).toISOString();
}

async function refreshDueTokens({
  refresh = require('./threadsAuth').refreshLongLivedToken,
  now = Date.now(),
  store = require('../infra/db'),
} = {}) {
  const { getAccount, listAllAccountsForSystem, updateAccount } = store;
  let refreshed = 0,
    failed = 0;
  for (const { id } of listAllAccountsForSystem()) {
    const account = getAccount(id);
    if (!needsRefresh(account, now)) continue;
    try {
      const data = await refresh(account.threads_access_token);
      if (!data?.access_token) throw new Error('refresh 응답에 access_token이 없습니다');
      updateAccount(id, {
        threads_access_token: data.access_token,
        threads_token_expires_at: expiryIso(data.expires_in, now),
      });
      refreshed++;
      console.log(`[Threads][TOKEN_REFRESH] account #${id} 갱신 완료`);
    } catch (e) {
      failed++;
      console.warn(
        `[Threads][TOKEN_REFRESH] account #${id} 갱신 실패: ${e.response?.data?.error?.message || e.message}`
      );
    }
  }
  return { refreshed, failed };
}

function startTokenRefreshJob() {
  const run = () => refreshDueTokens().catch(e => console.error('[Threads][TOKEN_REFRESH] job:', e.message));
  require('node-cron').schedule('17 4 * * *', run, { timezone: 'Asia/Seoul', noOverlap: true });
  setTimeout(run, 60000).unref?.();
  console.log('[Threads][TOKEN_REFRESH] daily long-lived token refresh ON (04:17 KST, <=10 days to expiry)');
}

module.exports = {
  parseTokenExpiry,
  isTokenExpired,
  needsRefresh,
  expiryIso,
  refreshDueTokens,
  startTokenRefreshJob,
  REFRESH_WITHIN_DAYS,
};
