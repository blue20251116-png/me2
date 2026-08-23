'use strict';

const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedThreadsMediaLoader(mod, filename) {
  if (path.basename(filename) !== 'threadsMediaImporter.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');

  if (!source.includes('MIN_VIDEO_BYTES')) {
    source = source.replace(
      "const MAX_BYTES = 200 * 1024 * 1024;",
      "const MAX_BYTES = 200 * 1024 * 1024;\nconst MIN_VIDEO_BYTES = Math.max(64 * 1024, Number(process.env.THREADS_MIN_VIDEO_BYTES || 100 * 1024));"
    );
  }

  source = source.replace(
    "    if (bytes < 1024) throw new Error('가져온 영상 파일이 비정상적으로 작습니다.');\n    return { filename, filepath, size: bytes };",
    `    if (bytes < MIN_VIDEO_BYTES) throw new Error(\`가져온 영상 파일이 너무 작습니다: \${bytes} bytes (< \${MIN_VIDEO_BYTES}). 다음 후보를 확인합니다.\`);\n    const head = fs.readFileSync(filepath, { encoding: null }).subarray(0, 32);\n    const ascii = head.toString('latin1');\n    const hasFtyp = head.length >= 12 && ascii.includes('ftyp');\n    if (!hasFtyp) throw new Error('MP4 컨테이너 헤더(ftyp)를 확인할 수 없습니다. 다음 후보를 확인합니다.');\n    return { filename, filepath, size: bytes };`
  );

  const thresholdOn = source.includes('MIN_VIDEO_BYTES');
  const headerOn = source.includes("MP4 컨테이너 헤더(ftyp)");
  console.log(`[Threads][VIDEO INTEGRITY] min-size=${thresholdOn?'ON':'FAIL'} mp4-header=${headerOn?'ON':'FAIL'} threshold=${Math.max(64 * 1024, Number(process.env.THREADS_MIN_VIDEO_BYTES || 100 * 1024))}`);

  mod._compile(source, filename);
};
