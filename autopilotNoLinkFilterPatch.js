const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');

  source = source.replace(
    "  if(!hasAffiliateLink(authorReplies))throw new Error('작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');\n",
    "  // 작성자 댓글의 쿠팡/네이버 링크 유무는 더 이상 소재 필수조건이 아니다.\n"
  );

  source = source.replace(
    '쇼핑링크 확인 source=${material.url}',
    '소재 후보채택 source=${material.url}'
  );

  source = source.replace(
    "작성자 댓글에 쇼핑 링크가 있다는 점을 고려해 무엇을 판매하는 글인지 최대한 구체적으로 추론하되 근거 없는 브랜드/모델은 만들지 않는다.",
    "본문·작성자 댓글·이미지/영상에서 실제 구매 가능한 대상을 최대한 구체적으로 추론하되 근거 없는 브랜드/모델은 만들지 않는다. 작성자 댓글에 쇼핑 링크가 없어도 정상 소재로 처리한다."
  );

  mod._compile(source, filename);
};

console.log('[Autopilot][NO-LINK-FILTER] 작성자 댓글 쇼핑링크 필수조건 제거 활성화');
