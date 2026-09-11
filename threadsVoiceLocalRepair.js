'use strict';

const { CONNECTOR_ONLY, DANGLING_PUNCTUATION_START, DANGLING_BOUND_NOUN_START } = require('./threadsVoiceLineGuards');
const codePointLength = value => Array.from(String(value || '')).length;

function repairConnectorOnlyBreaks(text, maxLineChars = 40) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim());
  const repaired = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    if (line && next && (CONNECTOR_ONLY.test(line) || DANGLING_PUNCTUATION_START.test(next) || DANGLING_BOUND_NOUN_START.test(next))) {
      const merged = `${line} ${next}`;
      if (codePointLength(merged) <= maxLineChars) {
        repaired.push(merged);
        i++;
        continue;
      }
    }
    repaired.push(line);
  }
  return repaired.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { repairConnectorOnlyBreaks };
