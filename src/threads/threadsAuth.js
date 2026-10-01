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

module.exports = { getAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, refreshLongLivedToken, fetchProfile };
