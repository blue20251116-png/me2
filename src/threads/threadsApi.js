'use strict';
// Publishing to Threads: single posts (text/image/video), carousels with per-item fallbacks,
// replies (the affiliate comment), and post insights.
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { db, getAccount } = require('../infra/db');
const { UPLOADS_DIR } = require('../config/paths');
const { editVideo } = require('../content/videoEditor');
const { pickTopicTag, isTopicTagRejection } = require('./topicTag');
const { normalizeMediaItems, decodeMediaBundle } = require('./mediaBundle');
const { cacheImage } = require('./imageCache');
const {
  sanitizePublishedThreadsText,
  applyCoupangReplyPreviewGuard,
  ensureCoupangDisclosureFirst,
} = require('./publishText');
const {
  GRAPH_BASE,
  sleep,
  logThreadsError,
  isRetryablePublishError,
  isTransientThreadsError,
  isInvalidCarouselChildrenError,
  canFallBackToText,
  mediaProcessingError,
  isMediaProcessingError,
} = require('./graphClient');

async function normalizeCarouselVideoUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const marker = '/uploads/';
    const idx = u.pathname.indexOf(marker);
    if (idx < 0) throw new Error('로컬 uploads URL이 아닙니다');
    const relative = decodeURIComponent(u.pathname.slice(idx + marker.length));
    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const inputPath = path.resolve(uploadsRoot, relative);
    if (!inputPath.startsWith(uploadsRoot + path.sep) && inputPath !== uploadsRoot)
      throw new Error('잘못된 uploads 경로입니다');
    if (!fs.existsSync(inputPath)) throw new Error('원본 영상 파일이 영속 저장소에 없습니다');
    const normalized = await editVideo({ inputPath, outputDir: uploadsRoot, start: 0, end: null, mute: false });
    const nextUrl = `${u.protocol}//${u.host}/uploads/${encodeURIComponent(normalized.filename)}`;
    console.log(
      `[Threads][CAROUSEL_VIDEO_NORMALIZE] success old=${rawUrl} new=${nextUrl} size=${normalized.size} duration=${Number(normalized.duration || 0).toFixed(2)}s`
    );
    return nextUrl;
  } catch (err) {
    console.error(`[Threads][CAROUSEL_VIDEO_NORMALIZE] failed url=${rawUrl} reason="${err.message}"`);
    return String(rawUrl || '');
  }
}

async function getContainerStatus(creationId, accessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${creationId}`, {
      params: { fields: 'id,status,error_message', access_token: accessToken },
      timeout: 15000,
    });
    return {
      id: res.data?.id || creationId,
      status: String(res.data?.status || '').toUpperCase(),
      errorMessage: res.data?.error_message || null,
    };
  } catch (err) {
    logThreadsError('MEDIA_STATUS', err, { creationId });
    throw err;
  }
}

async function waitForContainerReady(creationId, accessToken, { maxTries = 30, waitMs = 2000, label = 'MEDIA' } = {}) {
  let lastStatus = '';
  for (let i = 0; i < maxTries; i++) {
    const info = await getContainerStatus(creationId, accessToken);
    lastStatus = info.status;
    console.log(
      `[Threads][${label}_STATUS] creationId=${creationId} status=${info.status || '-'} try=${i + 1}/${maxTries}`
    );
    if (info.status === 'FINISHED' || info.status === 'PUBLISHED') return info;
    if (info.status === 'ERROR')
      throw mediaProcessingError(`Threads 미디어 처리 실패${info.errorMessage ? `: ${info.errorMessage}` : ''}`, {
        creationId,
        status: info.status,
        errorMessage: info.errorMessage || null,
        label,
      });
    if (info.status === 'EXPIRED')
      throw mediaProcessingError('Threads 미디어 컨테이너가 만료되었습니다', {
        creationId,
        status: info.status,
        label,
      });
    if (i < maxTries - 1) await sleep(waitMs);
  }
  throw mediaProcessingError(
    `Threads 미디어 준비 시간 초과 (creationId=${creationId}, status=${lastStatus || 'unknown'})`,
    { creationId, status: lastStatus || 'UNKNOWN', label }
  );
}

async function publishContainer(creationId, accessToken, maxTries = 5, baseWaitMs = 2000) {
  let lastError;
  for (let i = 0; i < maxTries; i++) {
    try {
      console.log(`[Threads][PUBLISH] 시작 creationId=${creationId} try=${i + 1}/${maxTries}`);
      let res;
      // publishQueue uses err.creationId/publishOutcomeUnknown to fail closed instead of
      // creating a duplicate post when /threads_publish errors after Threads already accepted it.
      try {
        res = await axios.post(`${GRAPH_BASE}/me/threads_publish`, null, {
          params: { creation_id: creationId, access_token: accessToken },
          timeout: 20000,
        });
      } catch (publishErr) {
        publishErr.creationId = String(creationId);
        publishErr.publishOutcomeUnknown = true;
        throw publishErr;
      }
      const mediaId = res.data?.id;
      if (!mediaId) throw new Error('Threads 발행 응답에 media id가 없습니다');
      console.log(`[Threads][PUBLISH] 성공 creationId=${creationId} mediaId=${mediaId}`);
      return mediaId;
    } catch (err) {
      lastError = err;
      logThreadsError('PUBLISH', err, { creationId, try: `${i + 1}/${maxTries}` });
      if (!isRetryablePublishError(err) || i === maxTries - 1) throw err;
      await sleep(Math.min(baseWaitMs + i * 2000, 12000));
    }
  }
  throw lastError;
}

// Creates a top-level post container. topic_tag (topicTag.js) is best-effort: if Threads
// rejects it, retry once without it so a tag can never be the reason a post fails to publish.
async function postThreadsContainer(params, timeout) {
  try {
    return await axios.post(`${GRAPH_BASE}/me/threads`, null, { params, timeout });
  } catch (err) {
    if (!params.topic_tag || !isTopicTagRejection(err)) throw err;
    console.warn(
      `[Threads][TOPIC_TAG] rejected tag="${params.topic_tag}" → retry without tag reason="${err.response?.data?.error?.message || err.message}"`
    );
    const rest = { ...params };
    delete rest.topic_tag;
    return axios.post(`${GRAPH_BASE}/me/threads`, null, { params: rest, timeout });
  }
}
async function publishPost(accountId, { text, imageUrl, videoUrl }) {
  text = sanitizePublishedThreadsText(text);
  const bundle = decodeMediaBundle(imageUrl);
  if (bundle?.length) return publishMediaItemsPost(accountId, { text, mediaItems: bundle });
  if (imageUrl) imageUrl = await cacheImage(imageUrl);
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  if (!account.threads_access_token) throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  if (!account.threads_user_id) throw new Error('Threads User ID가 없습니다. 계정을 다시 연결해주세요.');
  const accessToken = account.threads_access_token,
    mediaType = videoUrl ? 'VIDEO' : imageUrl ? 'IMAGE' : 'TEXT';
  console.log(`[Threads][CREATE] 시작 account=${accountId} userId=${account.threads_user_id} type=${mediaType}`);
  const params = { media_type: mediaType, text, access_token: accessToken };
  if (imageUrl) params.image_url = imageUrl;
  if (videoUrl) params.video_url = videoUrl;
  const topicTag = pickTopicTag(text);
  if (topicTag) params.topic_tag = topicTag;
  let creationId;
  try {
    const createRes = await postThreadsContainer(params, 30000);
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('Threads 컨테이너 생성 응답에 id가 없습니다');
    console.log(`[Threads][CREATE] 성공 account=${accountId} creationId=${creationId}`);
  } catch (err) {
    logThreadsError('CREATE', err, { accountId, userId: account.threads_user_id, mediaType });
    throw err;
  }
  if (mediaType === 'VIDEO') {
    await waitForContainerReady(creationId, accessToken, { maxTries: 40, waitMs: 2000, label: 'VIDEO' });
    return publishContainer(creationId, accessToken, 10, 3000);
  }
  if (mediaType === 'IMAGE')
    await waitForContainerReady(creationId, accessToken, { maxTries: 15, waitMs: 1000, label: 'IMAGE' });
  return publishContainer(creationId, accessToken, 5, 2000);
}

async function createCarouselChildContainer(accountId, item, accessToken, { maxTries = 3 } = {}) {
  const type = item.type;
  const params = { media_type: type, is_carousel_item: true, access_token: accessToken };
  if (type === 'VIDEO') params.video_url = item.url;
  else params.image_url = item.url;
  let lastError;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await axios.post(`${GRAPH_BASE}/me/threads`, null, { params, timeout: 30000 });
      const id = res.data?.id;
      if (!id) throw new Error('캐러셀 자식 컨테이너 응답에 id가 없습니다');
      console.log(`[Threads][CAROUSEL_CHILD] ${type} ${id} try=${i + 1}/${maxTries}`);
      return { id, type, url: item.url };
    } catch (err) {
      lastError = err;
      logThreadsError('CAROUSEL_CHILD_CREATE', err, { accountId, type, try: `${i + 1}/${maxTries}`, url: item.url });
      if (!isTransientThreadsError(err) || i === maxTries - 1) break;
      const waitMs = Math.min(1500 + i * 2000, 6000);
      console.warn(`[Threads][CAROUSEL_CHILD_RETRY] ${type} 일시 오류 → ${waitMs}ms 후 재시도`);
      await sleep(waitMs);
    }
  }
  if (isTransientThreadsError(lastError))
    throw mediaProcessingError(`Threads 캐러셀 ${type} 생성 일시 실패`, {
      type,
      url: item.url,
      originalError: lastError,
    });
  throw lastError;
}

async function createCarouselParent(accountId, text, children, accessToken, { maxTries = 5 } = {}) {
  text = sanitizePublishedThreadsText(text);
  let lastError;
  const childIds = children.map(x => x.id);
  for (let i = 0; i < maxTries; i++) {
    try {
      console.log(
        `[Threads][CAROUSEL_PARENT] 생성 시도 account=${accountId} try=${i + 1}/${maxTries} children=${childIds.join(',')}`
      );
      const params = { media_type: 'CAROUSEL', children: childIds.join(','), text, access_token: accessToken };
      const topicTag = pickTopicTag(text);
      if (topicTag) params.topic_tag = topicTag;
      const createRes = await postThreadsContainer(params, 30000);
      const creationId = createRes.data?.id;
      if (!creationId) throw new Error('캐러셀 부모 컨테이너 응답에 id가 없습니다');
      console.log(`[Threads][CAROUSEL_PARENT] 생성 성공 creationId=${creationId}`);
      return creationId;
    } catch (err) {
      lastError = err;
      logThreadsError('CAROUSEL_CREATE', err, { accountId, try: `${i + 1}/${maxTries}` });
      if (!isInvalidCarouselChildrenError(err) || i === maxTries - 1) throw err;
      console.log('[Threads][CAROUSEL_RETRY] 자식 상태를 다시 확인한 뒤 부모 생성을 재시도합니다');
      await Promise.all(
        children.map(child =>
          waitForContainerReady(child.id, accessToken, {
            maxTries: child.type === 'VIDEO' ? 20 : 10,
            waitMs: 2000,
            label: `CAROUSEL_${child.type}`,
          })
        )
      );
      await sleep(Math.min(2000 + i * 2000, 8000));
    }
  }
  throw lastError;
}

async function publishMediaItemsPost(accountId, { text, mediaItems }) {
  text = sanitizePublishedThreadsText(text);
  const items = normalizeMediaItems(mediaItems);
  if (!items.length) return publishPost(accountId, { text });
  let originalImages = 0,
    cachedImages = 0;
  for (const item of items) {
    if (item.type === 'IMAGE') {
      originalImages++;
      item.url = await cacheImage(item.url);
      cachedImages++;
    }
  }
  if (originalImages) console.log(`[Autopilot][IMAGE CACHE] 원본=${originalImages} 로컬성공=${cachedImages}`);
  if (cachedImages !== originalImages)
    throw new Error(`Threads 원본 이미지 ${originalImages}장 중 ${cachedImages}장만 로컬 캐시에 성공했습니다.`);
  if (items.length === 1) {
    try {
      return await publishPost(accountId, {
        text,
        imageUrl: items[0].type === 'IMAGE' ? items[0].url : null,
        videoUrl: items[0].type === 'VIDEO' ? items[0].url : null,
      });
    } catch (err) {
      if (!canFallBackToText(err)) throw err;
      console.warn(
        `[Threads][MEDIA_FALLBACK] 단일 ${items[0].type} 실패 → TEXT 발행 url=${items[0].url} reason="${err.message}"`
      );
      return publishPost(accountId, { text });
    }
  }
  const account = getAccount(accountId);
  if (!account?.threads_access_token) throw new Error('스레드 Access Token이 없습니다. 계정을 다시 연결해주세요.');
  const accessToken = account.threads_access_token;
  console.log(`[Threads][CAROUSEL_CREATE] 시작 account=${accountId} items=${items.length}`);

  const children = [];
  const createFailed = [];
  for (const item of items) {
    try {
      const child = await createCarouselChildContainer(accountId, item, accessToken, { maxTries: 3 });
      children.push(child);
    } catch (err) {
      if (!isMediaProcessingError(err) && !isTransientThreadsError(err)) throw err;
      createFailed.push({ item, err });
      console.warn(
        `[Threads][CAROUSEL_ITEM_CREATE_SKIP] ${item.type} 생성 실패 → 제외 url=${item.url} reason="${err.message}"`
      );
    }
    await sleep(item.type === 'VIDEO' ? 800 : 300);
  }

  if (createFailed.length)
    console.warn(`[Threads][CAROUSEL_CREATE_FALLBACK] 생성 성공=${children.length} 실패=${createFailed.length}`);
  if (!children.length) {
    console.warn('[Threads][CAROUSEL_FALLBACK] 자식 미디어 생성 전부 실패 → TEXT 발행');
    return publishPost(accountId, { text });
  }

  console.log(`[Threads][CAROUSEL_WAIT] 자식 ${children.length}개 준비 상태 확인`);
  const readyChildren = [];
  const failedChildren = [];
  for (const child of children) {
    try {
      await waitForContainerReady(child.id, accessToken, {
        maxTries: child.type === 'VIDEO' ? 40 : 20,
        waitMs: child.type === 'VIDEO' ? 2000 : 1000,
        label: `CAROUSEL_${child.type}`,
      });
      readyChildren.push(child);
    } catch (err) {
      if (!isMediaProcessingError(err)) throw err;

      if (child.type === 'VIDEO') {
        console.warn(
          `[Threads][CAROUSEL_VIDEO_RECREATE] 1차 VIDEO 처리 실패 → ffmpeg 정상화 후 새 child 재생성 oldId=${child.id} url=${child.url} reason="${err.message}"`
        );
        let retryUrl = child.url;
        try {
          retryUrl = await normalizeCarouselVideoUrl(child.url);
        } catch {}
        await sleep(1200);
        try {
          const retryChild = await createCarouselChildContainer(
            accountId,
            { type: 'VIDEO', url: retryUrl },
            accessToken,
            { maxTries: 3 }
          );
          await waitForContainerReady(retryChild.id, accessToken, {
            maxTries: 40,
            waitMs: 2000,
            label: 'CAROUSEL_VIDEO_RETRY',
          });
          readyChildren.push(retryChild);
          console.log(
            `[Threads][CAROUSEL_VIDEO_RECREATE] 성공 oldId=${child.id} newId=${retryChild.id} normalized=${retryUrl !== child.url ? 'yes' : 'no'}`
          );
          continue;
        } catch (retryErr) {
          if (!isMediaProcessingError(retryErr) && !isTransientThreadsError(retryErr)) throw retryErr;
          console.error(
            `[Threads][CAROUSEL_VIDEO_ABORT] 정상화 후 VIDEO도 실패 → 이미지 단독 발행 금지 oldId=${child.id} oldUrl=${child.url} retryUrl=${retryUrl} reason="${retryErr.message}"`
          );
          throw mediaProcessingError('예약글 VIDEO 정상화 재시도 실패 - 이미지 단독 발행을 차단했습니다', {
            type: 'VIDEO',
            url: retryUrl,
            originalError: retryErr,
          });
        }
      }

      failedChildren.push({ child, err });
      console.warn(
        `[Threads][CAROUSEL_ITEM_SKIP] ${child.type} 처리 실패 → 제외 id=${child.id} url=${child.url} reason="${err.message}"`
      );
    }
  }
  if (failedChildren.length)
    console.warn(`[Threads][CAROUSEL_FALLBACK] 준비 성공=${readyChildren.length} 실패=${failedChildren.length}`);
  if (!readyChildren.length) {
    console.warn('[Threads][CAROUSEL_FALLBACK] 모든 미디어 처리 실패 → TEXT 발행');
    return publishPost(accountId, { text });
  }
  if (readyChildren.length === 1) {
    const survivor = readyChildren[0];
    console.warn(`[Threads][CAROUSEL_FALLBACK] 미디어 1개만 정상 → 단일 ${survivor.type}로 재생성 후 발행`);
    try {
      return await publishPost(accountId, {
        text,
        imageUrl: survivor.type === 'IMAGE' ? survivor.url : null,
        videoUrl: survivor.type === 'VIDEO' ? survivor.url : null,
      });
    } catch (err) {
      if (!canFallBackToText(err)) throw err;
      console.warn(`[Threads][CAROUSEL_FALLBACK] 남은 ${survivor.type}도 실패 → TEXT 발행 reason="${err.message}"`);
      return publishPost(accountId, { text });
    }
  }
  const creationId = await createCarouselParent(accountId, text, readyChildren, accessToken, { maxTries: 5 });
  try {
    await waitForContainerReady(creationId, accessToken, { maxTries: 30, waitMs: 2000, label: 'CAROUSEL_PARENT' });
    return publishContainer(creationId, accessToken, 10, 3000);
  } catch (err) {
    if (!isMediaProcessingError(err)) throw err;
    console.warn(
      `[Threads][CAROUSEL_PARENT_FALLBACK] 부모 처리 실패 → 첫 정상 미디어 1개로 발행 reason="${err.message}"`
    );
    const survivor = readyChildren[0];
    try {
      return await publishPost(accountId, {
        text,
        imageUrl: survivor.type === 'IMAGE' ? survivor.url : null,
        videoUrl: survivor.type === 'VIDEO' ? survivor.url : null,
      });
    } catch (singleErr) {
      if (!canFallBackToText(singleErr)) throw singleErr;
      console.warn(`[Threads][CAROUSEL_PARENT_FALLBACK] 단일 미디어도 실패 → TEXT 발행 reason="${singleErr.message}"`);
      return publishPost(accountId, { text });
    }
  }
}

async function publishCarouselPost(accountId, { text, imageUrls }) {
  return publishMediaItemsPost(accountId, {
    text,
    mediaItems: (imageUrls || []).filter(Boolean).map(url => ({ type: 'IMAGE', url })),
  });
}

async function publishReply(accountId, parentMediaId, text, options = {}) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  if (!account.threads_access_token) throw new Error('스레드 Access Token이 없습니다');
  const accessToken = account.threads_access_token;
  const beforeDisclosure = String(text || '').trim();
  text = ensureCoupangDisclosureFirst(beforeDisclosure);
  if (text !== beforeDisclosure)
    console.log(`[Threads][COUPANG DISCLOSURE FIRST] account=${accountId} parentMediaId=${parentMediaId}`);
  const guarded = applyCoupangReplyPreviewGuard(text);
  if (options.creationId) {
    const status = await getContainerStatus(options.creationId, accessToken);
    if (status.status === 'PUBLISHED')
      throw Object.assign(new Error('기존 댓글이 이미 발행됨: 결과 확인 필요'), { code: 'COMMENT_OUTCOME_UNKNOWN' });
    return publishContainer(options.creationId, accessToken, 3, 2500);
  }
  text = guarded.text;
  console.log(
    `[Threads][REPLY_PREVIEW_GUARD] account=${accountId} parentMediaId=${parentMediaId} applied=${guarded.guardApplied ? 'yes' : 'no'} coupangUrls=${guarded.urlCount} text=${JSON.stringify(text)}`
  );
  let creationId;
  try {
    const createRes = await axios.post(`${GRAPH_BASE}/me/threads`, null, {
      params: { media_type: 'TEXT', text, reply_to_id: parentMediaId, access_token: accessToken },
      timeout: 20000,
    });
    creationId = createRes.data?.id;
    if (!creationId) throw new Error('Threads 댓글 컨테이너 생성 응답에 id가 없습니다');
    console.log(
      `[Threads][REPLY_CREATE] 성공 account=${accountId} parentMediaId=${parentMediaId} creationId=${creationId}`
    );
  } catch (err) {
    logThreadsError('REPLY_CREATE', err, { accountId, parentMediaId });
    throw err;
  }
  if (options.onCreated) await options.onCreated(creationId);
  await sleep(2500);
  return publishContainer(creationId, accessToken, 3, 2500);
}

function isDeadMediaError(err) {
  const data = err?.response?.data?.error || err?.response?.data || {};
  const code = Number(data?.code || err?.code || 0);
  const subcode = Number(data?.error_subcode || data?.subcode || err?.error_subcode || 0);
  const msg = String(data?.message || err?.message || '');
  return (
    (code === 100 && subcode === 33) ||
    /Unsupported get request.*does not exist|missing permissions|does not support this operation/i.test(msg)
  );
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
    for (const item of res.data?.data || []) data[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
    return data;
  } catch (err) {
    logThreadsError('INSIGHTS', err, { accountId, mediaId });
    if (isDeadMediaError(err) && mediaId) {
      try {
        const result = db
          .prepare(`UPDATE posts SET threads_media_id=NULL WHERE account_id=? AND threads_media_id=?`)
          .run(Number(accountId), String(mediaId));
        console.warn(
          `[Threads][INSIGHTS DEAD-ID] mediaId=${mediaId} accountId=${accountId} → 향후 인사이트 조회 제외 rows=${result.changes || 0}`
        );
      } catch (dbErr) {
        console.warn(`[Threads][INSIGHTS DEAD-ID] DB 제외 실패 mediaId=${mediaId}: ${dbErr.message}`);
      }
    }
    throw err;
  }
}

module.exports = {
  publishPost,
  publishCarouselPost,
  publishMediaItemsPost,
  publishReply,
  publishContainer,
  getMediaInsights,
};
