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

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function resolvePreviewSinkUrl(account) {
  const explicit = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.APP_URL);
  if (explicit) return `${explicit}/threads-preview-sink.txt`;

  const railway = normalizeBaseUrl(process.env.RAILWAY_PUBLIC_DOMAIN);
  if (railway) return `${railway}/threads-preview-sink.txt`;

  const shared = typeof db.getSystemApiSettings === 'function' ? db.getSystemApiSettings() : null;
  const redirect = String(shared?.threads_redirect_uri || account?.threads_redirect_uri || process.env.THREADS_REDIRECT_URI || '').trim();
  if (redirect) {
    try {
      const u = new URL(redirect);
      return `${u.protocol}//${u.host}/threads-preview-sink.txt`;
    } catch {}
  }

  return '';
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
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`[Threads][REPLY NO-PREVIEW][PUBLISH] creationId=${creationId} try=${i + 1}/3`);
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
      console.warn(`[Threads][REPLY NO-PREVIEW][PUBLISH ERROR] status=${err?.response?.status || '-'} code=${apiErr.code || '-'} subcode=${apiErr.error_subcode || '-'} message=${apiErr.message || err?.message || '-'} try=${i + 1}/3`);
      if (!isRetryablePublishError(err) || i === 2) throw err;
      await sleep(Math.min(2000 + i * 2000, 6000));
    }
  }
  throw lastError;
}

async function createNoPreviewReply({ accountId, parentMediaId, text, accessToken, sinkUrl }) {
  // Threads API 문서상 TEXT에 link_attachment가 없으면 text의 첫 URL을 자동 미리보기로 사용한다
  // 그래서 쿠팡 URL은 text에 그대로 두되 link_attachment는 미리보기 정보가 없는 text/plain sink로 명시한다
  // 목적: 쿠팡 링크는 클릭 가능하게 유지하면서 쿠팡 상품 OG 카드가 자동 생성되는 것을 막는다
  const params = {
    media_type: 'TEXT',
    text,
    reply_to_id: parentMediaId,
    link_attachment: sinkUrl,
    access_token: accessToken,
  };

  const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
    params,
    timeout: 20000,
  });
  const creationId = createRes.data?.id;
  if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
  console.log(`[Threads][REPLY NO-PREVIEW][CREATE] account=${accountId} creationId=${creationId} coupangUrls=${coupangLinks(text).length} sink=${sinkUrl}`);
  return creationId;
}

threadsApi.publishReply = async function publishReplyNoPreview(accountId, parentMediaId, text) {
  if (!hasCoupangLink(text)) return originalPublishReply(accountId, parentMediaId, text);

  const account = db.getAccount(accountId);
  if (!account?.threads_access_token) return originalPublishReply(accountId, parentMediaId, text);

  const sinkUrl = resolvePreviewSinkUrl(account);
  if (!sinkUrl) {
    console.warn('[Threads][REPLY NO-PREVIEW][FALLBACK] 공개 sink URL을 만들 수 없어 기존 댓글 방식 사용');
    return originalPublishReply(accountId, parentMediaId, text);
  }

  try {
    const creationId = await createNoPreviewReply({
      accountId,
      parentMediaId,
      text,
      accessToken: account.threads_access_token,
      sinkUrl,
    });
    return await publishCreatedReply(creationId, account.threads_access_token);
  } catch (err) {
    const apiErr = err?.response?.data?.error || {};
    console.warn(`[Threads][REPLY NO-PREVIEW][FALLBACK] sink attachment 방식 실패 → 기존 API 댓글 방식 사용 status=${err?.response?.status || '-'} code=${apiErr.code || '-'} message=${apiErr.message || err?.message || '-'}`);
    return originalPublishReply(accountId, parentMediaId, text);
  }
};

console.log('[Threads][REPLY NO-PREVIEW PATCH] 쿠팡 URL은 text에 유지 + 별도 text/plain sink를 link_attachment로 지정');
