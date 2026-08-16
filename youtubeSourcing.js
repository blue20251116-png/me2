const { getSystemApiSettings } = require('./db');
const youtubeApi = require('./youtubeApi');
const { suggestYoutubeSearchKeywords } = require('./aiCaption');

// 완전자동화(오토파일럿)가 쿠팡 상품을 하나 고른 뒤, 그 상품과 관련된 YouTube 콘텐츠를
// 자동으로 찾아서 AI 글 생성에 넘길 소재 1개를 골라주는 레이어.
//
// 매우 중요: 이 함수는 절대 예외를 던지지 않는다. Key 없음/검색 실패/quota 초과/네트워크
// 오류 등 무엇이 일어나도 여기서 잡아서 null을 반환하고 로그만 남긴다 — 완전자동화 전체가
// YouTube 단계 때문에 실패하면 안 되기 때문이다. 호출하는 쪽(scheduler.js)은 반환값이
// null이면 그냥 기존 상품 기반 글 생성으로 진행하면 된다.

// 상품 관련성(50) + 조회수(20) + 최근성(15) + 영상 활용성(15) = 100점 만점으로 후보를 채점.
// 정확한 알고리즘이라기보다는, "조회수만 높고 상품과 무관한 영상"이 뽑히지 않게 하기 위한
// 실용적인 근사치다.
function scoreVideo(video, keywordTerms) {
  const haystack = `${video.title || ''} ${video.description || ''}`.toLowerCase();
  const terms = (keywordTerms || []).filter(Boolean);
  const matched = terms.filter((t) => haystack.includes(String(t).toLowerCase())).length;
  const relevance = terms.length ? (matched / terms.length) * 50 : 25;

  // 조회수는 로그 스케일로 정규화 (100만 조회수 근처에서 만점에 근접)
  const viewsScore = Math.min(20, (Math.log10((video.views || 0) + 1) / 6) * 20);

  // 최근성: 90일 이내면 만점, 그 이후로는 서서히 감소 (오래된 영상도 완전히 배제하진 않음)
  let recencyScore = 0;
  if (video.publishedAt) {
    const days = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = Math.max(0, 15 - Math.max(0, days - 90) / 30);
  }

  // 영상 활용성: 너무 짧거나(5초 미만) 너무 길면(3분 초과) 소재로 쓰기 애매하므로 감점
  const dur = video.durationSeconds || 0;
  let usability = 15;
  if (dur < 5 || dur > 180) usability = 5;
  else if (dur < 10) usability = 10;

  return relevance + viewsScore + recencyScore + usability;
}

// accountId/productName을 받아서 가장 적합한 YouTube 소재 1개를 찾아 반환.
// 실패하거나 적합한 후보가 없으면 null.
async function findAutopilotYoutubeSource({ accountId, productName, order = 'relevance', logPrefix = '[YouTube]' }) {
  try {
    const shared = getSystemApiSettings();
    const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      console.log(`${logPrefix} API Key 미설정 — 기존 상품 기반 글 생성으로 진행`);
      return null;
    }

    // 검색용 핵심 키워드 1~3개 준비. AI 생성이 실패해도 상품명 자체로 폴백해서 계속 진행.
    let keywords;
    try {
      keywords = await suggestYoutubeSearchKeywords(accountId, productName);
    } catch (err) {
      console.log(`${logPrefix} 검색 키워드 AI 생성 실패, 상품명으로 폴백: ${err.message}`);
      keywords = null;
    }
    keywords = (keywords || []).filter(Boolean).slice(0, 3);
    if (!keywords.length) keywords = [productName];

    console.log(`${logPrefix} 관련 콘텐츠 검색 시작: ${keywords.join(' / ')}`);

    // 쿼터를 아끼기 위해, 후보가 충분히 모이면 남은 키워드는 검색하지 않고 중단
    const candidates = new Map();
    for (const kw of keywords) {
      if (candidates.size >= 6) break;
      try {
        const videos = await youtubeApi.searchVideos({ apiKey, keyword: kw, order, maxResults: 10 });
        for (const v of videos) {
          if (!candidates.has(v.id)) candidates.set(v.id, v);
        }
      } catch (err) {
        const reason = err.response?.data?.error?.errors?.[0]?.reason || err.message;
        console.log(`${logPrefix} "${kw}" 검색 실패: ${reason}`);
      }
    }

    if (!candidates.size) {
      console.log(`${logPrefix} 적합한 콘텐츠 없음 — 기존 상품 기반 글 생성`);
      return null;
    }

    console.log(`${logPrefix} 후보 ${candidates.size}개 발견`);

    const keywordTerms = keywords.join(' ').split(/\s+/);
    let best = null;
    let bestScore = -1;
    for (const v of candidates.values()) {
      const score = scoreVideo(v, keywordTerms);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }

    if (!best) {
      console.log(`${logPrefix} 적합한 콘텐츠 없음 — 기존 상품 기반 글 생성`);
      return null;
    }

    console.log(`${logPrefix} 콘텐츠 선택: ${best.title} (score=${bestScore.toFixed(1)})`);

    // 향후 프레임 추출/이미지 확장을 대비해 확장 가능한 형태로 반환 (지금은 최소 필드만 채움)
    return {
      id: best.id,
      title: best.title,
      description: best.description,
      channelTitle: best.channelTitle,
      url: best.url,
      views: best.views,
      publishedAt: best.publishedAt,
      images: null,
      frames: null,
      analysis: null,
    };
  } catch (err) {
    // 위에서 못 잡은 예외까지 여기서 최종 방어 — 완전자동화가 절대 멈추면 안 되므로
    console.log(`[YouTube] 소싱 단계 오류, 기존 자동화로 진행: ${err.message}`);
    return null;
  }
}

module.exports = { findAutopilotYoutubeSource };
