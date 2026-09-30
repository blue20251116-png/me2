'use strict';
const axios = require('axios');
const cheerio = require('cheerio');

// 브라우저처럼 보이도록 User-Agent 지정 (없으면 차단하는 사이트가 많음)
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// 쿠팡파트너스 단축링크(link.coupang.com)는 실제 상품페이지로 리다이렉트되므로
// axios의 follow-redirect 기본 동작으로 최종 URL까지 따라간 뒤 그 페이지를 파싱한다.
// Any logged-in user can hand this an arbitrary URL, so refuse internal targets (cloud metadata
// 169.254.169.254, localhost, private ranges, Railway private networking) on the first hop and on
// every redirect hop. Public shop pages are unaffected.
function isBlockedHost(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local'))
    return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:'))
    return h.includes(':');
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('올바른 URL이 아닙니다');
  }
  if (!['http:', 'https:'].includes(u.protocol) || isBlockedHost(u.hostname))
    throw new Error('가져올 수 없는 주소입니다');
  return u.toString();
}

async function scrapeProduct(url) {
  const res = await axios.get(assertPublicUrl(url), {
    headers: BROWSER_HEADERS,
    timeout: 10000,
    maxRedirects: 5,
    beforeRedirect: options => {
      if (isBlockedHost(options.hostname)) throw new Error('가져올 수 없는 주소입니다');
    },
  });

  const $ = cheerio.load(res.data);

  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDescription = $('meta[property="og:description"]').attr('content');

  // 쿠팡 상품페이지는 og:title에 "상품명 - 쿠팡" 형태로 들어가는 경우가 많아 뒤 " - 쿠팡" 제거
  const cleanTitle = (ogTitle || '').replace(/\s*-\s*쿠팡!?\s*$/i, '').trim();

  if (!ogImage) {
    throw new Error(
      '이미지를 찾지 못했습니다 (사이트에서 크롤링을 차단했을 수 있어요). 이미지 URL을 직접 입력해주세요.'
    );
  }

  // 상세페이지에 들어있는 추가 상품 이미지도 최대한 긁어옴 (썸네일 하나만이 아니라 여러 장 중 고를 수 있게)
  // 페이지 구조는 사이트가 언제든 바꿀 수 있어서 100% 보장은 안 되는 best-effort 방식
  const detailImages = new Set([ogImage]);
  $('img').each((_, el) => {
    if (detailImages.size >= 8) return; // 너무 많이 긁어오지 않도록 상한
    const src = $(el).attr('data-src') || $(el).attr('src');
    if (!src) return;
    const absoluteUrl = src.startsWith('http') ? src : new URL(src, url).href;
    const w = Number($(el).attr('width')) || 0;
    const h = Number($(el).attr('height')) || 0;
    // 아이콘/로고 같은 작은 이미지는 걸러내고, 상품 사진처럼 보이는 것만 후보로
    const looksLikeIcon = (w && w < 200) || (h && h < 200) || /icon|logo|sprite|badge/i.test(absoluteUrl);
    if (!looksLikeIcon && /^https?:\/\//.test(absoluteUrl)) {
      detailImages.add(absoluteUrl);
    }
  });

  return {
    imageUrl: ogImage,
    images: Array.from(detailImages), // 첫 번째가 항상 대표 이미지(og:image)
    title: cleanTitle || null,
    description: ogDescription || null,
    finalUrl: res.request?.res?.responseUrl || url, // 리다이렉트 최종 URL (참고용)
  };
}

module.exports = { isBlockedHost, scrapeProduct };
