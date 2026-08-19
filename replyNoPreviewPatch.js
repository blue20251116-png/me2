const axios = require('axios');
const db = require('./db');
const threadsApi = require('./threadsApi');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const originalPublishReply = threadsApi.publishReply;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hasCoupangLink(text) {
  return /https?:\/\/link\.coupang\.com\//i.test(String(text || ''));
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

threadsApi.publishReply = async function publishReplyNoPreview(accountId, parentMediaId, text) {
  if (!hasCoupangLink(text)) return originalPublishReply(accountId, parentMediaId, text);

  const account = db.getAccount(accountId);
  if (!account?.threads_access_token) return originalPublishReply(accountId, parentMediaId, text);

  const accessToken = account.threads_access_token;
  let creationId;

  try {
    // Meta 문서상 link_attachment가 없으면 text의 첫 URL이 자동 프리뷰가 된다.
    // 앱의 '미리보기 X 제거'와 같은 결과가 가능한지, 빈 attachment를 명시해 안전하게 실험한다.
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
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
    console.log(`[Threads][REPLY NO-PREVIEW] 빈 link_attachment 컨테이너 생성 성공 account=${accountId} creationId=${creationId}`);
  } catch (err) {
    const apiErr = err?.response?.data?.error || {};
    console.warn(`[Threads][REPLY NO-PREVIEW][FALLBACK] 빈 link_attachment 거부 → 기존 API 댓글 방식 사용 status=${err?.response?.status || '-'} code=${apiErr.code || '-'} message=${apiErr.message || err?.message || '-'}`);
    return originalPublishReply(accountId, parentMediaId, text);
  }

  // 생성이 성공한 뒤에는 중복 댓글 위험 때문에 기존 방식으로 재생성하지 않는다.
  return publishCreatedReply(creationId, accessToken);
};

console.log('[Threads][REPLY NO-PREVIEW PATCH] 쿠파스 답글 빈 link_attachment 실험 + 생성 실패 시 기존 방식 fallback 활성화');
