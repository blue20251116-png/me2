const threadsApi = require('./threadsApi');

const originalPublishReply = threadsApi.publishReply;

function ensureCoupangDisclosureFirst(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return raw;

  const lines = raw.split('\n');
  const disclosureIndex = lines.findIndex(line => /쿠팡\s*파트너스\s*활동의\s*일환/i.test(line));
  if (disclosureIndex < 0) return raw;

  const disclosure = lines[disclosureIndex].trim();
  const rest = lines
    .filter((_, index) => index !== disclosureIndex)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return rest ? `${disclosure}\n\n${rest}` : disclosure;
}

threadsApi.publishReply = async function publishReplyWithDisclosureFirst(accountId, parentMediaId, text) {
  const before = String(text || '').trim();
  const normalized = ensureCoupangDisclosureFirst(before);

  if (normalized !== before) {
    console.log(`[Threads][COUPANG DISCLOSURE FIRST] account=${accountId} parentMediaId=${parentMediaId}`);
  }

  return originalPublishReply(accountId, parentMediaId, normalized);
};

console.log('[Threads][REPLY PATCH] 쿠팡 고지문 첫줄 고정 · preview sink/link_attachment 제거');
