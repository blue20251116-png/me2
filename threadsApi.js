const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function resolveThreadsAppCreds(account) {
  const shared = getSystemApiSettings();
  return {
    appId: shared.threads_app_id || process.env.THREADS_APP_ID || account?.threads_app_id || null,
    appSecret: shared.threads_app_secret || process.env.THREADS_APP_SECRET || account?.threads_app_secret || null,
    redirectUri: shared.threads_redirect_uri || process.env.THREADS_REDIRECT_URI || account?.threads_redirect_uri || null,
  };
}

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function logThreadsError(stage, err, extra = {}) {
  const apiErr = err.response?.data?.error || {};
  const status = err.response?.status || '-';
  console.error(
    `[Threads][${stage}][ERROR] status=${status} type=${apiErr.type || '-'} code=${apiErr.code || '-'} ` +
    `subcode=${apiErr.error_subcode || '-'} message=${apiErr.message || err.message || '-'} ` +
    Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
  );
  console.error(`[Threads][${stage}][RAW]`, JSON.stringify(err.response?.data || {}));
}

function getAuthUrl(accountId) {
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
  return `https://threads.net/oauth/authorize?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}&response_type=code&state=${encodeURIComponent(accountId)}`;
}

async function exchangeCodeForToken(accountId, code) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const { appId, appSecret, redirectUri } = resolveThreadsAppCreds(account);
  try {
    const res = await axios.post('https://graph.threads.net/oauth/access_token', null, {
      params: { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
      timeout: 20000,
    });
    return res.data;
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
    const res = await axios.get(`${GRAPH_BASE}/access_token`, {
      params: { grant_type: 'th_exchange_token', client_secret: appSecret, access_token: shortLivedToken },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    logThreadsError('OAUTH_LONG_TOKEN', err, { accountId });
    throw err;
  }
}

async function refreshLongLivedToken(currentToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/refresh_access_token`, {
      params: { grant_type: 'th_refresh_token', access_token: currentToken },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    logThreadsError('TOKEN_REFRESH', err);
    throw err;
  }
}

async function fetchProfile(accessToken, userId) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/me`, {
      params: { fields: 'username', access_token: accessToken },
      timeout: 15000,
    });
    return res.data.username;
  } catch (err) {
    logThreadsError('PROFILE', err, { userId });
    throw err;
  }
}

function isRetryablePublishError(err) {
  const apiErr = err.response?.data?.error || {};
  const message = String(apiErr.message || err.message || '').toLowerCase();
  return (
    err.response?.status === 404 ||
    apiErr.code === 24 ||
    message.includes('requested resource does not exist') ||
    message.includes('media not found') ||
    message.includes('not ready') ||
    message.includes('still processing') ||
    message.includes('processing') ||
    message.includes('please wait') ||
    message.includes('try again')
  );
}

async function publishContainer(creationId, accessToken, maxTries = 5, baseWaitMs = 2000) {
  let lastError;
  for (let i = 0; i < maxTries; i++) {
    try {
      console.log(`[Threads][PUBLISH] 시작 creationId=${creationId} try=${i + 1}/${maxTries}`);
      const res = await axios.post(`${GRAPH_BASE}/me/threads_publish`, null, {
        params: { creation_id: creationId, access_token: accessToken },
        timeout: 20000,
      });
      const mediaId = res.data?.id;
      if (!mediaId) throw new Error('Threads 발행 응답에 media id가 없습니다');
      console.log(`[Threads][PUBLISH] 성공 creationId=${creationId} mediaId=${mediaId}`);
      return mediaId;
    } catch (err) {
      lastError = err;
      logThreadsError('PUBLISH', err, { creationId, try: `${i + 1}/${maxTries}` });
      if (!isRetryablePublishError(err) || i === maxTries - 1) throw err;
      const waitMs = Math.min(baseWaitMs + i * 2000, 12000);
      console.log(`[Threads][PUBLISH] 아직 처리 중으로 판단 · ${waitMs}ms 후 재시도`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function publishPost(accountId, { text, imageUrl, videoUrl }) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  if (!account.threads_access_token) throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  if (!account.threads_user_id) throw new Error('Threads User ID가 없습니다. 계정을 다시 연결해주세요.');

  const accessToken = account.threads_access_token;
  const mediaType = videoUrl ? 'VIDEO' : imageUrl ? 'IMAGE' : 'TEXT';
  console.log(`[Threads][CREATE] 시작 account=${accountId} userId=${account.threads_user_id} type=${mediaType}`);

  const params = { media_type: mediaType, text, access_token: accessToken };
  if (imageUrl) params.image_url = imageUrl;
  if (videoUrl) params.video_url = videoUrl;

  let creationId;
  try {
    const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, { params, timeout: 30000 });
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('Threads 컨테이너 생성 응답에 id가 없습니다');
    console.log(`[Threads][CREATE] 성공 account=${accountId} creationId=${creationId}`);
  } catch (err) {
    logThreadsError('CREATE', err, { accountId, userId: account.threads_user_id, mediaType });
    throw err;
  }

  // Threads API의 현재 컨테이너 객체에는 status_code 필드가 없을 수 있다.
  // 따라서 VIDEO에서 GET /{creationId}?fields=status_code 를 호출하지 않는다.
  // 대신 영상은 인코딩 시간을 확보한 뒤 publish를 시도하고, 아직 처리 중인 오류만 재시도한다.
  if (mediaType === 'VIDEO') {
    console.log(`[Threads][VIDEO_WAIT] creationId=${creationId} · 인코딩 대기 8초`);
    await sleep(8000);
    return publishContainer(creationId, accessToken, 10, 3000);
  }

  await sleep(1500);
  return publishContainer(creationId, accessToken, 5, 2000);
}

async function createCarouselChildContainer(accountId, imageUrl, accessToken) {
  try {
    const res = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
      params: { media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: true, access_token: accessToken },
      timeout: 30000,
    });
    const id = res.data?.id;
    if (!id) throw new Error('캐러셀 자식 컨테이너 응답에 id가 없습니다');
    return id;
  } catch (err) {
    logThreadsError('CAROUSEL_CHILD_CREATE', err, { accountId, imageUrl });
    throw err;
  }
}

async function publishCarouselPost(accountId, { text, imageUrls }) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  if (!account.threads_access_token) throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  if (!account.threads_user_id) throw new Error('Threads User ID가 없습니다. 계정을 다시 연결해주세요.');
  const urls = (imageUrls || []).filter(Boolean);
  if (urls.length < 2) return publishPost(accountId, { text, imageUrl: urls[0] });

  const accessToken = account.threads_access_token;
  console.log(`[Threads][CAROUSEL_CREATE] 시작 account=${accountId} images=${urls.length}`);
  const childIds = [];
  for (const url of urls) {
    childIds.push(await createCarouselChildContainer(accountId, url, accessToken));
    await sleep(1000);
  }

  let creationId;
  try {
    const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
      params: { media_type: 'CAROUSEL', children: childIds.join(','), text, access_token: accessToken },
      timeout: 30000,
    });
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('캐러셀 부모 컨테이너 응답에 id가 없습니다');
    console.log(`[Threads][CAROUSEL_CREATE] 성공 account=${accountId} creationId=${creationId}`);
  } catch (err) {
    logThreadsError('CAROUSEL_CREATE', err, { accountId, userId: account.threads_user_id });
    throw err;
  }

  await sleep(1500);
  return publishContainer(creationId, accessToken, 5, 2000);
}

async function publishReply(accountId, parentMediaId, text) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  if (!account.threads_access_token) throw new Error('스레드 Access Token이 없습니다');
  const accessToken = account.threads_access_token;
  console.log(`[Threads][REPLY_CREATE] 시작 account=${accountId} parent=${parentMediaId}`);

  let creationId;
  try {
    const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
      params: { media_type: 'TEXT', text, reply_to_id: parentMediaId, access_token: accessToken },
      timeout: 20000,
    });
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
    console.log(`[Threads][REPLY_CREATE] 성공 creationId=${creationId}`);
  } catch (err) {
    logThreadsError('REPLY_CREATE', err, { accountId, parentMediaId });
    throw err;
  }

  await sleep(1500);
  return publishContainer(creationId, accessToken, 5, 2000);
}

async function getMediaInsights(accountId, mediaId) {
  const account = getAccount(accountId);
  if (!account || !account.threads_access_token) throw new Error('스레드 Access Token이 없습니다');
  try {
    const res = await axios.get(`${GRAPH_BASE}/${mediaId}/insights`, {
      params: { metric: 'views,likes,replies,reposts,quotes', access_token: account.threads_access_token },
      timeout: 20000,
    });
    const data = {};
    for (const item of res.data?.data || []) {
      data[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
    }
    return data;
  } catch (err) {
    logThreadsError('INSIGHTS', err, { accountId, mediaId });
    throw err;
  }
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  refreshLongLivedToken,
  fetchProfile,
  publishPost,
  publishCarouselPost,
  publishReply,
  getMediaInsights,
};
