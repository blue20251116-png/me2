// Threads Insights: Meta code=100/subcode=33인 죽은 mediaId를 DB에서 제외
// 한 번 확인된 잘못된 mediaId를 1분마다 다시 조회하지 않도록 한다.
const threadsApi = require('./threadsApi');
const { db } = require('./db');

const original = threadsApi.getMediaInsights.bind(threadsApi);

function isDeadMediaError(err) {
  const data = err?.response?.data?.error || err?.response?.data || {};
  const code = Number(data?.code || err?.code || 0);
  const subcode = Number(data?.error_subcode || data?.subcode || err?.error_subcode || 0);
  const msg = String(data?.message || err?.message || '');
  return (code === 100 && subcode === 33) || /Unsupported get request.*does not exist|missing permissions|does not support this operation/i.test(msg);
}

threadsApi.getMediaInsights = async function patchedGetMediaInsights(accountId, mediaId) {
  try {
    return await original(accountId, mediaId);
  } catch (err) {
    if (isDeadMediaError(err) && mediaId) {
      try {
        const result = db.prepare(`UPDATE posts SET threads_media_id=NULL WHERE account_id=? AND threads_media_id=?`).run(Number(accountId), String(mediaId));
        console.warn(`[Threads][INSIGHTS DEAD-ID] mediaId=${mediaId} accountId=${accountId} → 향후 인사이트 조회 제외 rows=${result.changes || 0}`);
      } catch (dbErr) {
        console.warn(`[Threads][INSIGHTS DEAD-ID] DB 제외 실패 mediaId=${mediaId}: ${dbErr.message}`);
      }
    }
    throw err;
  }
};

console.log('[Threads][INSIGHTS DEAD-ID PATCH] code=100/subcode=33 mediaId 자동 제외 활성화');
