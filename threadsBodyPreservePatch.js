'use strict';

const Module = require('module');
const originalLoader = Module._extensions['.js'];
let applied = false;

function transformScheduler(src) {
  if (applied) return src;
  const re = /function splitThreadsSentences\(text\)\{[\s\S]*?function formatThreadsBody\(text\)\{[\s\S]*?return paragraphs\.filter\(Boolean\)\.slice\(0,5\)\.join\('\\n\\n'\)\.trim\(\);\}/;
  if (!re.test(src)) {
    console.warn('[Threads][BODY PRESERVE] scheduler format block not found');
    return src;
  }
  const replacement = `function splitThreadsSentences(text){return String(text||'').replace(/\\r/g,'').replace(/\\\\n/g,'\\n').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().split('\\n').map(x=>x.trim()).filter(Boolean);}\nfunction formatThreadsBody(text){return String(text||'').replace(/\\r/g,'').replace(/\\\\n/g,'\\n').replace(/,/g,'').replace(/(^|[^0-9])\\.(?![0-9])/g,'$1').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();}`;
  applied = true;
  console.log('[Threads][BODY PRESERVE] scheduler 예약 저장 시 생성된 줄/빈줄 그대로 보존');
  return src.replace(re, replacement);
}

Module._extensions['.js'] = function bodyPreserveLoader(mod, filename) {
  if (filename.endsWith('/scheduler.js') || filename.endsWith('\\scheduler.js')) {
    const fs = require('fs');
    const src = fs.readFileSync(filename, 'utf8');
    mod._compile(transformScheduler(src), filename);
    return;
  }
  return originalLoader(mod, filename);
};

console.log('[Threads][BODY PRESERVE] patch armed');
