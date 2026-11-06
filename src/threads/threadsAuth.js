'use strict';
// Threads OAuth: authorize URL, code → short-lived → long-lived token, refresh, profile.
const axios = require('axios');
const { getAccount } = require('../infra/db');
const { GRAPH_BASE, resolveThreadsAppCreds, logThreadsError } = require('./graphClient');

function getAuthUrl(accountId, state) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const { appId, redirectUri } = resolveThreadsAppCreds(account);
  if (!appId) throw new Error('Threads App ID가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  if (!redirectUri) throw new Error('Threads Redirect URI가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  const scopes = [
    'threads_basic',
    'threads_content_publish',
    'threads_manage_insights',
    'threads_manage_replies',
    'threads_read_replies',
  ].join(',');
  return `https://threads.net/oauth/authorize?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&response_type=code&state=${encodeURIComponent(state ?? accountId)}`;
}

// 11/5 meaiflow 연결 실패(4476002 "요청과 함께 앱 ID가 전송되지 않았습니다"): 공용 설정에 Threads 앱 ID가 아니라
// Meta 앱(페이스북) ID가 들어 있었다. Threads authorize 화면은 모르는 ID를 "앱 ID 없음"으로 표시하므로,
// 연결 버튼을 누를 때 graph.threads.net 앱 토큰 발급으로 ID/시크릿을 먼저 확인하고 알아볼 수 있는 안내를 띄운다.
const appCheckCache = new Map();
async function checkThreadsAppCreds(account) {
  if (process.env.NODE_ENV === 'test' || process.env.THREADS_APP_PREFLIGHT === '0') return { ok: true, skipped: true };
  const { appId, appSecret } = resolveThreadsAppCreds(account);
  if (!appId || !appSecret) return { ok: true, skipped: true };
  const key = `${appId}:${appSecret.length}:${appSecret.slice(-4)}`;
  const hit = appCheckCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.result;
  let result;
  try {
    await axios.get('https://graph.threads.net/oauth/access_token', {
      params: { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' },
      timeout: 10000,
    });
    result = { ok: true };
  } catch (err) {
    const msg = String(err.response?.data?.error?.message || '');
    if (err.response?.status === 400 && /invalid client_id/i.test(msg)) result = { ok: false, reason: 'app_id' };
    else if (err.response?.status === 400 && /secret/i.test(msg)) result = { ok: false, reason: 'app_secret' };
    else return { ok: true, skipped: true }; // 네트워크 문제 등은 연결을 막지 않는다
  }
  appCheckCache.set(key, { at: Date.now(), result });
  return result;
}

async function exchangeCodeForToken(accountId, code) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const { appId, appSecret, redirectUri } = resolveThreadsAppCreds(account);
  try {
    return (
      await axios.post('https://graph.threads.net/oauth/access_token', null, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        },
        timeout: 20000,
      })
    ).data;
  } catch (err) {
    logThreadsError('OAUTH_SHORT_TOKEN', err, { accountId });
    throw err;
  }
}

async function exchangeForLongLivedToken(accountId, shortLivedToken) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const { appSecret } = resolveThreadsAppCreds(account);
  try {
    return (
      await axios.get(`${GRAPH_BASE}/access_token`, {
        params: { grant_type: 'th_exchange_token', client_secret: appSecret, access_token: shortLivedToken },
        timeout: 20000,
      })
    ).data;
  } catch (err) {
    logThreadsError('OAUTH_LONG_TOKEN', err, { accountId });
    throw err;
  }
}

async function refreshLongLivedToken(currentToken) {
  try {
    return (
      await axios.get(`${GRAPH_BASE}/refresh_access_token`, {
        params: { grant_type: 'th_refresh_token', access_token: currentToken },
        timeout: 20000,
      })
    ).data;
  } catch (err) {
    logThreadsError('TOKEN_REFRESH', err);
    throw err;
  }
}

async function fetchProfile(accessToken, userId) {
  try {
    return (
      await axios.get(`${GRAPH_BASE}/me`, { params: { fields: 'username', access_token: accessToken }, timeout: 15000 })
    ).data.username;
  } catch (err) {
    logThreadsError('PROFILE', err, { userId });
    throw err;
  }
}

module.exports = { getAuthUrl, checkThreadsAppCreds, exchangeCodeForToken, exchangeForLongLivedToken, refreshLongLivedToken, fetchProfile };
