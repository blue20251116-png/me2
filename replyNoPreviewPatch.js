const axios = require('axios');
const db = require('./db');
const threadsApi = require('./threadsApi');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const originalPublishReply = threadsApi.publishReply;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function coupangLinks(text) {
  return String(text || '').match(/https?:\/\/link\.coupang\.com\/\S+/gi) || [];
}

function hasCoupangLink(text) {
  return coupangLinks(text).length > 0;
}

function isRetryablePublishError(err) {
  const apiErr = err?.response?.data?.error || {};
  const status = Number(err?.response?.status || 0);
  const code = Number(apiErr.code || 0);
  const message = String(apiErr.message || apiErr.error_user_msg || err?.message || '').toLowerCase();
  return status === 404 || code === 24 || message.includes('requested resource does not exist') || message.includes('media not found') || message.includes('not ready') || message.includes('processing') || message.includes('please wait') || message.includes('try again');
}

async function publishCreatedReply(creationId, accessToken) {
  let lastError;
  for (let i = 0; i < 5; i++) {
    try {
      console.log(`[Threads][REPLY NO-PREVIEW][PUBLISH] creationId=${creationId} try=${i + 1}/5`);
      const res = await axios.post(`${GRAPH_BASE}/me/threads_publish`, null, {
        params: { creation_id: creationId, access_token: accessToken },
        timeout: 20000,
      });
      const mediaId = res.data?.id;
      if (!mediaId) throw new Error('Threads 댓글 발행 응답에 media id가 없습니다');
      console.log(`[Threads][REPLY NO-PREVIEW][SUCCESS] creationId=${creationId} mediaId=${mediaId}`);
      return mediaId;
    } catch (err) {
      lastError = err;
      const apiErr = err?.response?.data?.error || {};
      console.warn(`[Threads][REPLY NO-PREVIEW][PUBLISH ERROR] status=${err?.response?.status || '-'} code=${apiErr.code || '-'} subcode=${apiErr.error_subcode || '-'} message=${apiErr.message || err?.message || '-'} try=${i + 1}/5`);
      if (!isRetryablePublishError(err) || i === 4) throw err;
      await sleep(Math.min(2000 + i * 2000, 10000));
    }
  }
  throw lastError;
}

async function createNoPreviewReply({ accountId, parentMediaId, text, accessToken, duplicateBlankAttachment = false }) {
  // Meta API의 link_attachment는 공식적으로 단일 필드지만
  // 쿠팡 링크를 두 번 넣는 댓글에서는 앱 UI의 미리보기 제거 동작에 최대한 가깝게
  // 빈 link_attachment를 URL-encoded 파라미터로 링크 개수만큼 반복 전송해 본다
  // API가 중복 필드를 거부하면 호출부에서 단일 빈 필드 방식으로 안전하게 재시도한다
  if (duplicateBlankAttachment) {
    const body = new URLSearchParams();
    body.append('media_type', 'TEXT');
    body.append('text', text);
    body.append('reply_to_id', String(parentMediaId));
    body.append('link_attachment', '');
    body.append('link_attachment', '');
    body.append('access_token', accessToken);

    const res = await axios.post(`${GRAPH_BASE}/me/threads`, body, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    });
    const creationId = res.data?.id;
    if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
    console.log(`[Threads][REPLY NO-PREVIEW][DOUBLE] 링크 2개 → 빈 link_attachment 2회 전송 성공 account=${accountId} creationId=${creationId}`);
    return creationId;
  }

  const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
    params: {
      media_type: 'TEXT',
      text,
      reply_to_id: parentMediaId,
      link_attachment: '',
      access_token: accessToken,
    },
    timeout: 20000,
  });
  const creationId = createRes.data?.id;
  if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
  console.log(`[Threads][REPLY NO-PREVIEW][SINGLE] 빈 link_attachment 컨테이너 생성 성공 account=${accountId} creationId=${creationId}`);
  return creationId;
}

threadsApi.publishReply = async function publishReplyNoPreview(accountId, parentMediaId, text) {
  if (!hasCoupangLink(text)) return originalPublishReply(accountId, parentMediaId, text);

  const account = db.getAccount(accountId);
  if (!account?.threads_access_token) return originalPublishReply(accountId, parentMediaId, text);

  const accessToken = account.threads_access_token;
  const linkCount = coupangLinks(text).length;
  let creationId;

  // 링크가 2개 이상이면 먼저 빈 attachment 2회 전송을 실험한다
  if (linkCount >= 2) {
    try {
      creationId = await createNoPreviewReply({
        accountId,
        parentMediaId,
        text,
        accessToken,
        duplicateBlankAttachment: true,
      });
    } catch (err) {
      const apiErr = err?.response?.data?.error || {};
      console.warn(`[Threads][REPLY NO-PREVIEW][DOUBLE FALLBACK] 중복 빈 attachment 거부 → 단일 빈 attachment 재시도 status=${err?.response?.status || '-'} code=${apiErr.code || '-'} message=${apiErr.message || err?.message || '-'}`);
    }
  }

  // 링크가 1개이거나 2회 전송이 실패했으면 기존 단일 빈 attachment 방식
  if (!creationId) {
    try {
      creationId = await createNoPreviewReply({
        accountId,
        parentMediaId,
        text,
        accessToken,
        duplicateBlankAttachment: false,
      });
    } catch (err) {
      const apiErr = err?.response?.data?.error || {};
      console.warn(`[Threads][REPLY NO-PREVIEW][FALLBACK] 빈 link_attachment 거부 → 기존 API 댓글 방식 사용 status=${err?.response?.status || '-'} code=${apiErr.code || '-'} message=${apiErr.message || err?.message || '-'}`);
      return originalPublishReply(accountId, parentMediaId, text);
    }
  }

  // 컨테이너 생성이 성공한 뒤에는 중복 댓글 위험 때문에 다른 방식으로 재생성하지 않는다
  return publishCreatedReply(creationId, accessToken);
};

console.log('[Threads][REPLY NO-PREVIEW PATCH] 쿠파스 링크 2개면 빈 link_attachment 2회 실험 → 실패 시 단일 방식 fallback');
