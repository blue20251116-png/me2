'use strict';

const CONNECTOR_ONLY = /^(?:그리고|근데|그래서|하지만|또|또는|혹은|및)$/;
const codePointLength = value => Array.from(String(value || '')).length;

function repairConnectorOnlyBreaks(text, maxLineChars = 18) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim());
  const repaired = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    if (line && next && CONNECTOR_ONLY.test(line)) {
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
