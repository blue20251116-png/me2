const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

// SaaS 전환: 새 고객이 계정을 연결할 때마다 Meta App ID/Secret을 직접 입력하지 않아도 되게,
// 운영자가 등록한 서버 환경변수를 기본값으로 쓰고, 계정별로 따로 입력한 값이 있으면 그걸 우선한다.
function resolveThreadsAppCreds(account) {
  const shared = getSystemApiSettings();
  return {
    appId: shared.threads_app_id || process.env.THREADS_APP_ID || account?.threads_app_id || null,
    appSecret: shared.threads_app_secret || process.env.THREADS_APP_SECRET || account?.threads_app_secret || null,
    redirectUri: shared.threads_redirect_uri || process.env.THREADS_REDIRECT_URI || account?.threads_redirect_uri || null,
  };
}

const GRAPH_BASE = 'https://graph.threads.net/v1.0';

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


// ============================================================
// 에러 로그 헬퍼
// ============================================================

function logThreadsError(stage, err, extra = {}) {
  const apiErr = err.response?.data?.error || {};
  const status = err.response?.status || '-';

  console.error(
    `[Threads][${stage}][ERROR] ` +
    `status=${status} ` +
    `type=${apiErr.type || '-'} ` +
    `code=${apiErr.code || '-'} ` +
    `subcode=${apiErr.error_subcode || '-'} ` +
    `message=${apiErr.message || err.message || '-'} ` +
    Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
  );

  console.error(
    `[Threads][${stage}][RAW]`,
    JSON.stringify(err.response?.data || {})
  );
}


// ============================================================
// OAuth
// ============================================================

// Threads 로그인 URL 생성
// state에 accountId를 넣어서
// 로그인 완료 후 어느 계정인지 다시 구분
function getAuthUrl(accountId) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  const { appId, redirectUri } = resolveThreadsAppCreds(account);

  if (!appId) {
    throw new Error('Threads App ID가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }

  if (!redirectUri) {
    throw new Error('Threads Redirect URI가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }

  const scopes = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_insights',
  'threads_manage_replies',
  'threads_read_replies',
].join(',');
  
  return (
    `https://threads.net/oauth/authorize` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(accountId)}`
  );
}


// OAuth code → 단기 Access Token
async function exchangeCodeForToken(accountId, code) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  const { appId, appSecret, redirectUri } = resolveThreadsAppCreds(account);

  try {
    const res = await axios.post(
      'https://graph.threads.net/oauth/access_token',
      null,
      {
        params: {
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        },
        timeout: 20000,
      }
    );

    return res.data;
  } catch (err) {
    logThreadsError('OAUTH_SHORT_TOKEN', err, {
      accountId,
    });

    throw err;
  }
}


// 단기 Access Token → 장기 Access Token
async function exchangeForLongLivedToken(
  accountId,
  shortLivedToken
) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  const { appSecret } = resolveThreadsAppCreds(account);

  try {
    const res = await axios.get(
      `${GRAPH_BASE}/access_token`,
      {
        params: {
          grant_type: 'th_exchange_token',
          client_secret: appSecret,
          access_token: shortLivedToken,
        },
        timeout: 20000,
      }
    );

    return res.data;
  } catch (err) {
    logThreadsError('OAUTH_LONG_TOKEN', err, {
      accountId,
    });

    throw err;
  }
}


// 장기 Token 갱신
async function refreshLongLivedToken(currentToken) {
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/refresh_access_token`,
      {
        params: {
          grant_type: 'th_refresh_token',
          access_token: currentToken,
        },
        timeout: 20000,
      }
    );

    return res.data;
  } catch (err) {
    logThreadsError('TOKEN_REFRESH', err);
    throw err;
  }
}


// 연결 직후 Threads 사용자명 가져오기
async function fetchProfile(accessToken, userId) {
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/${userId}`,
      {
        params: {
          fields: 'username',
          access_token: accessToken,
        },
        timeout: 15000,
      }
    );

    return res.data.username;
  } catch (err) {
    logThreadsError('PROFILE', err, {
      userId,
    });

    throw err;
  }
}


// ============================================================
// 미디어 처리
// ============================================================

// VIDEO는 Meta 서버에서 인코딩 시간이 필요함
async function waitForContainerReady(
  creationId,
  accessToken,
  maxTries = 30
) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await axios.get(
        `${GRAPH_BASE}/${creationId}`,
        {
          params: {
            fields: 'status_code',
            access_token: accessToken,
          },
          timeout: 15000,
        }
      );

      const status = res.data?.status_code;

      console.log(
        `[Threads][MEDIA_STATUS] creationId=${creationId} ` +
        `try=${i + 1}/${maxTries} status=${status}`
      );

      if (status === 'FINISHED') {
        return;
      }

      if (status === 'ERROR') {
        throw new Error(
          'Threads 서버에서 영상 처리에 실패했습니다'
        );
      }

      await sleep(3000);
    } catch (err) {
      logThreadsError('MEDIA_STATUS', err, {
        creationId,
        try: `${i + 1}/${maxTries}`,
      });

      throw err;
    }
  }

  throw new Error(
    'Threads 영상 처리 시간이 너무 오래 걸립니다'
  );
}


// ============================================================
// Publish 재시도
// ============================================================

function isRetryablePublishError(err) {
  const apiErr = err.response?.data?.error;
  const message = String(
    apiErr?.message || err.message || ''
  ).toLowerCase();

  return (
    err.response?.status === 404 ||
    apiErr?.code === 24 ||
    message.includes('requested resource does not exist') ||
    message.includes('media not found') ||
    message.includes('not ready')
  );
}


async function publishContainer(
  creationId,
  accessToken,
  maxTries = 5
) {
  let lastError;

  for (let i = 0; i < maxTries; i++) {
    try {
      console.log(
        `[Threads][PUBLISH] 시작 ` +
        `creationId=${creationId} ` +
        `try=${i + 1}/${maxTries}`
      );

      const res = await axios.post(
        `${GRAPH_BASE}/me/threads_publish`,
        null,
        {
          params: {
            creation_id: creationId,
            access_token: accessToken,
          },
          timeout: 20000,
        }
      );

      const mediaId = res.data?.id;

      if (!mediaId) {
        throw new Error(
          'Threads 발행 응답에 media id가 없습니다'
        );
      }

      console.log(
        `[Threads][PUBLISH] 성공 ` +
        `creationId=${creationId} ` +
        `mediaId=${mediaId}`
      );

      return mediaId;

    } catch (err) {
      lastError = err;

      logThreadsError(
        'PUBLISH',
        err,
        {
          creationId,
          try: `${i + 1}/${maxTries}`,
        }
      );

      if (
        !isRetryablePublishError(err) ||
        i === maxTries - 1
      ) {
        throw err;
      }

      // Threads 내부에서 컨테이너가
      // 아직 publish 노드에 전파되지 않았을 경우 대비
      const waitMs = 2000 + i * 2000;

      console.log(
        `[Threads][PUBLISH] ${waitMs}ms 후 재시도`
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}


// ============================================================
// 본문 발행
// ============================================================

async function publishPost(
  accountId,
  {
    text,
    imageUrl,
    videoUrl,
  }
) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  if (!account.threads_access_token) {
    throw new Error(
      '스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.'
    );
  }

  if (!account.threads_user_id) {
    throw new Error(
      'Threads User ID가 없습니다. 계정을 다시 연결해주세요.'
    );
  }

  const accessToken =
    account.threads_access_token;

  const mediaType = videoUrl
    ? 'VIDEO'
    : imageUrl
      ? 'IMAGE'
      : 'TEXT';


  console.log(
    `[Threads][CREATE] 시작 ` +
    `account=${accountId} ` +
    `userId=${account.threads_user_id} ` +
    `type=${mediaType}`
  );


  const params = {
    media_type: mediaType,
    text,
    access_token: accessToken,
  };


  if (imageUrl) {
    params.image_url = imageUrl;
  }


  if (videoUrl) {
    params.video_url = videoUrl;
  }


  let creationId;


  try {
    // Meta 공식 예제 방식
    // POST /me/threads
    const createRes = await axios.post(
      `${GRAPH_BASE}/me/threads`,
      null,
      {
        params,
        timeout: 30000,
      }
    );


    creationId =
      createRes.data?.id;


    if (!creationId) {
      throw new Error(
        'Threads 컨테이너 생성 응답에 id가 없습니다'
      );
    }


    console.log(
      `[Threads][CREATE] 성공 ` +
      `account=${accountId} ` +
      `creationId=${creationId}`
    );

  } catch (err) {

    logThreadsError(
      'CREATE',
      err,
      {
        accountId,
        userId:
          account.threads_user_id,
        mediaType,
      }
    );

    throw err;
  }


  // VIDEO만 인코딩 완료 확인
  if (mediaType === 'VIDEO') {

    await waitForContainerReady(
      creationId,
      accessToken
    );

  }


  // 컨테이너 생성 직후
  // Threads 내부 반영 시간 약간 확보
  await sleep(1500);


  return publishContainer(
    creationId,
    accessToken
  );
}


// ============================================================
// 댓글 / 답글 발행
// ============================================================

async function publishReply(
  accountId,
  parentMediaId,
  text
) {

  const account =
    getAccount(accountId);


  if (!account) {
    throw new Error(
      '존재하지 않는 계정입니다'
    );
  }


  if (!account.threads_access_token) {
    throw new Error(
      '스레드 Access Token이 없습니다'
    );
  }


  const accessToken =
    account.threads_access_token;


  console.log(
    `[Threads][REPLY_CREATE] 시작 ` +
    `account=${accountId} ` +
    `parent=${parentMediaId}`
  );


  let creationId;


  try {

    const createRes =
      await axios.post(
        `${GRAPH_BASE}/me/threads`,
        null,
        {
          params: {
            media_type: 'TEXT',
            text,
            reply_to_id:
              parentMediaId,
            access_token:
              accessToken,
          },

          timeout: 20000,
        }
      );


    creationId =
      createRes.data?.id;


    if (!creationId) {
      throw new Error(
        'Threads 댓글 컨테이너 생성 응답에 id가 없습니다'
      );
    }


    console.log(
      `[Threads][REPLY_CREATE] 성공 ` +
      `creationId=${creationId}`
    );

  } catch (err) {

    logThreadsError(
      'REPLY_CREATE',
      err,
      {
        accountId,
        parentMediaId,
      }
    );

    throw err;
  }


  await sleep(1500);


  return publishContainer(
    creationId,
    accessToken
  );
}


// ============================================================
// 인사이트
// ============================================================

async function getMediaInsights(
  accountId,
  mediaId
) {

  const account =
    getAccount(accountId);


  if (
    !account ||
    !account.threads_access_token
  ) {
    throw new Error(
      '스레드 Access Token이 없습니다'
    );
  }


  try {

    const res =
      await axios.get(
        `${GRAPH_BASE}/${mediaId}/insights`,
        {
          params: {
            metric:
              'views,likes,replies,reposts,quotes',

            access_token:
              account.threads_access_token,
          },

          timeout: 20000,
        }
      );


    const data = {};


    for (
      const item of
      res.data?.data || []
    ) {

      data[item.name] =
        item.values?.[0]?.value ??
        item.total_value?.value ??
        0;

    }


    return data;

  } catch (err) {

    logThreadsError(
      'INSIGHTS',
      err,
      {
        accountId,
        mediaId,
      }
    );

    throw err;
  }
}


// ============================================================
// Export
// ============================================================

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  refreshLongLivedToken,
  fetchProfile,
  publishPost,
  publishReply,
  getMediaInsights,
};
