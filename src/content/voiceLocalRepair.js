'use strict';

const { CONNECTOR_ONLY, DANGLING_PUNCTUATION_START, DANGLING_BOUND_NOUN_START } = require('./voiceLineGuards');
const codePointLength = value => Array.from(String(value || '')).length;

function repairConnectorOnlyBreaks(text, maxLineChars = 40) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim());
  const repaired = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    if (
      line &&
      next &&
      (CONNECTOR_ONLY.test(line) || DANGLING_PUNCTUATION_START.test(next) || DANGLING_BOUND_NOUN_START.test(next))
    ) {
      const merged = `${line} ${next}`;
      if (codePointLength(merged) <= maxLineChars) {
        repaired.push(merged);
        i++;
        continue;
      }
    }
    repaired.push(line);
  }
  return repaired
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Regroups the lines into 2-3 line paragraphs. Fixes "문단 과다 분절" (every line its own paragraph)
// and "문단 과다" (more than maxParagraphs) without another AI call; wording is left untouched.
function regroupParagraphs(text, maxParagraphs = 5) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return lines.join('\n');
  for (let size = 2; size <= lines.length; size++) {
    const groups = [];
    for (let i = 0; i < lines.length; i += size) groups.push(lines.slice(i, i + size));
    // A trailing one-line paragraph joins the previous one so no paragraph stands alone.
    if (groups.length > 1 && groups[groups.length - 1].length === 1) groups[groups.length - 2].push(...groups.pop());
    if (groups.length <= maxParagraphs) return groups.map(g => g.join('\n')).join('\n\n');
  }
  return lines.join('\n');
}

module.exports = { repairConnectorOnlyBreaks, regroupParagraphs };
