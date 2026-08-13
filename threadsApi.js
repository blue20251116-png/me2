const axios = require('axios');
const { getAccount } = require('./db');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- OAuth ----
function getAuthUrl(accountId) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');

  const scopes = [
    'threads_basic',
    'threads_content_publish',
    'threads_manage_insights',
  ].join(',');

  return `https://threads.net/oauth/authorize?client_id=${account.threads_app_id}&redirect_uri=${encodeURIComponent(
    account.threads_redirect_uri
  )}&scope=${scopes}&response_type=code&state=${accountId}`;
}

// 단기 토큰 발급
async function exchangeCodeForToken(accountId, code) {
  const account = getAccount(accountId);

  const res = await axios.post(
    'https://graph.threads.net/oauth/access_token',
    null,
    {
      params: {
        client_id: account.threads_app_id,
        client_secret: account.threads_app_secret,
        grant_type: 'authorization_code',
        redirect_uri: account.threads_redirect_uri,
        code,
      },
    }
  );

  return res.data;
}

// 장기 토큰 교환
async function exchangeForLongLivedToken(accountId, shortLivedToken) {
  const account = getAccount(accountId);

  const res = await axios.get(`${GRAPH_BASE}/access_token`, {
    params: {
      grant_type: 'th_exchange_token',
      client_secret: account.threads_app_secret,
      access_token: shortLivedToken,
    },
  });

  return res.data;
}

// 장기 토큰 갱신
async function refreshLongLivedToken(currentToken) {
  const res = await axios.get(`${GRAPH_BASE}/refresh_access_token`, {
    params: {
      grant_type: 'th_refresh_token',
      access_token: currentToken,
    },
  });

  return res.data;
}

// 사용자명 가져오기
async function fetchProfile(accessToken, userId) {
  const res = await axios.get(`${GRAPH_BASE}/${userId}`, {
    params: {
      fields: 'username',
      access_token: accessToken,
    },
  });

  return res.data.username;
}

// 영상 컨테이너 준비 대기
async function waitForContainerReady(
  creationId,
  accessToken,
  maxTries = 20
) {
  for (let i = 0; i < maxTries; i++) {
    const res = await axios.get(`${GRAPH_BASE}/${creationId}`, {
      params: {
        fields: 'status_code',
        access_token: accessToken,
      },
    });

    const status = res.data.status_code;

    if (status === 'FINISHED') {
      return;
    }

    if (status === 'ERROR') {
      throw new Error(
        '영상 처리에 실패했습니다 (Threads 서버 측 인코딩 오류)'
      );
    }

    await sleep(3000);
  }

  throw new Error('영상 처리 시간이 너무 오래 걸립니다');
}

// 컨테이너 생성 직후 resource not found 오류인지 확인
function isContainerPropagationError(err) {
  const status = err.response?.status;
  const apiErr = err.response?.data?.error;

  const message = String(
    apiErr?.message || err.message || ''
  ).toLowerCase();

  return (
    status === 404 ||
    apiErr?.code === 24 ||
    apiErr?.error_subcode === 4279009 ||
    message.includes('requested resource does not exist') ||
    message.includes('media not found')
  );
}

// Threads publish 재시도
async function publishContainerWithRetry(
  userId,
  creationId,
  accessToken,
  maxTries = 6
) {
  let lastErr;

  // 컨테이너 생성 직후 Threads 내부 반영 시간 확보
  await sleep(3000);

  for (let i = 0; i < maxTries; i++) {
    try {
      const publishRes = await axios.post(
        `${GRAPH_BASE}/${userId}/threads_publish`,
        null,
        {
          params: {
            creation_id: creationId,
            access_token: accessToken,
          },
        }
      );

      return publishRes.data.id;
    } catch (err) {
      lastErr = err;

      const apiErr = err.response?.data?.error;

      console.error(
        `[Threads publish 재시도 ${i + 1}/${maxTries}] ` +
          `creationId=${creationId} ` +
          `status=${err.response?.status || '-'} ` +
          `code=${apiErr?.code || '-'} ` +
          `subcode=${apiErr?.error_subcode || '-'} ` +
          `message=${apiErr?.message || err.message}`
      );

      // resource propagation 관련 오류가 아니면 즉시 중단
      if (
        !isContainerPropagationError(err) ||
        i === maxTries - 1
      ) {
        throw err;
      }

      // 3초 → 5초 → 7초 → 9초...
      await sleep(3000 + i * 2000);
    }
  }

  throw lastErr;
}

// --------------------------------------------------
// 본문 발행
// --------------------------------------------------
async function publishPost(
  accountId,
  { text, imageUrl, videoUrl }
) {
  const account = getAccount(accountId);

  if (
    !account?.threads_user_id ||
    !account?.threads_access_token
  ) {
    throw new Error(
      '스레드 계정이 아직 연결되지 않았습니다 (연결 설정에서 로그인 필요)'
    );
  }

  const {
    threads_user_id: userId,
    threads_access_token: accessToken,
  } = account;

  const mediaType = videoUrl
    ? 'VIDEO'
    : imageUrl
    ? 'IMAGE'
    : 'TEXT';

  console.log(
    `[Threads] container 생성 시작 account=${accountId} userId=${userId} type=${mediaType}`
  );

  let createRes;

  try {
    createRes = await axios.post(
      `${GRAPH_BASE}/${userId}/threads`,
      null,
      {
        params: {
          media_type: mediaType,
          text,

          ...(imageUrl
            ? {
                image_url: imageUrl,
              }
            : {}),

          ...(videoUrl
            ? {
                video_url: videoUrl,
              }
            : {}),

          access_token: accessToken,
        },
      }
    );
  } catch (err) {
    const apiErr = err.response?.data?.error;

    console.error(
      `[Threads] container 생성 실패 ` +
        `account=${accountId} ` +
        `userId=${userId} ` +
        `status=${err.response?.status || '-'} ` +
        `code=${apiErr?.code || '-'} ` +
        `subcode=${apiErr?.error_subcode || '-'} ` +
        `message=${apiErr?.message || err.message}`
    );

    throw err;
  }

  const creationId = createRes.data?.id;

  if (!creationId) {
    throw new Error(
      'Threads 컨테이너 생성 응답에 id가 없습니다'
    );
  }

  console.log(
    `[Threads] container 생성 완료 creationId=${creationId}`
  );

  // 영상만 인코딩 완료까지 대기
  if (mediaType === 'VIDEO') {
    await waitForContainerReady(
      creationId,
      accessToken
    );
  }

  // TEXT / IMAGE / VIDEO 모두 publish 전에 대기 + 재시도
  const mediaId =
    await publishContainerWithRetry(
      userId,
      creationId,
      accessToken
    );

  console.log(
    `[Threads] 발행 완료 mediaId=${mediaId}`
  );

  return mediaId;
}

// --------------------------------------------------
// 댓글 발행
// --------------------------------------------------
async function publishReply(
  accountId,
  parentMediaId,
  text
) {
  const account = getAccount(accountId);

  if (
    !account?.threads_user_id ||
    !account?.threads_access_token
  ) {
    throw new Error(
      '스레드 계정이 아직 연결되지 않았습니다 (연결 설정에서 로그인 필요)'
    );
  }

  const {
    threads_user_id: userId,
    threads_access_token: accessToken,
  } = account;

  const createRes = await axios.post(
    `${GRAPH_BASE}/${userId}/threads`,
    null,
    {
      params: {
        media_type: 'TEXT',
        text,
        reply_to_id: parentMediaId,
        access_token: accessToken,
      },
    }
  );

  const creationId = createRes.data?.id;

  if (!creationId) {
    throw new Error(
      'Threads 댓글 컨테이너 생성 응답에 id가 없습니다'
    );
  }

  return publishContainerWithRetry(
    userId,
    creationId,
    accessToken
  );
}

// --------------------------------------------------
// 인사이트
// --------------------------------------------------
async function getMediaInsights(
  accountId,
  mediaId
) {
  const account = getAccount(accountId);

  if (!account?.threads_access_token) {
    throw new Error(
      '스레드 액세스 토큰이 없습니다'
    );
  }

  const res = await axios.get(
    `${GRAPH_BASE}/${mediaId}/insights`,
    {
      params: {
        metric:
          'views,likes,replies,reposts,quotes',
        access_token:
          account.threads_access_token,
      },
    }
  );

  const data = {};

  for (const item of res.data.data) {
    data[item.name] =
      item.values?.[0]?.value ??
      item.total_value?.value ??
      0;
  }

  return data;
}

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
