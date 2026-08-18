// Normalize escaped line breaks in Threads replies before publish.
// Some AI-generated comment fields can contain literal "\\n" sequences,
// which Threads renders as the two characters \ and n unless converted here.
const threadsApi = require('./threadsApi');

if (!threadsApi.__commentTextPatchApplied) {
  const originalPublishReply = threadsApi.publishReply;

  function normalizeReplyText(text) {
    return String(text ?? '')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  threadsApi.publishReply = async function patchedPublishReply(accountId, parentMediaId, text) {
    const normalized = normalizeReplyText(text);
    if (normalized !== String(text ?? '').trim()) {
      console.log(`[Threads][COMMENT TEXT PATCH] literal newline escape normalized account=${accountId}`);
    }
    return originalPublishReply(accountId, parentMediaId, normalized);
  };

  threadsApi.__commentTextPatchApplied = true;
  console.log('[Threads][COMMENT TEXT PATCH] 댓글 literal \\n 개행 정규화 활성화');
}
