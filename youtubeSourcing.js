const { getSystemApiSettings } = require('./db');
const youtubeApi = require('./youtubeApi');
const { suggestYoutubeSearchKeywords } = require('./aiCaption');

// 완전자동화가 상품과 관련된 YouTube 콘텐츠를 찾아 AI 글 생성 소재 1개를 고른다.
// 어떤 오류가 발생해도 자동화 전체를 막지 않고 null로 폴백한다.
function scoreVideo(video, keywordTerms) {
  const haystack = `${video.title || ''} ${video.description || ''}`.toLowerCase();
  const terms = (keywordTerms || []).filter(Boolean);
  const matched = terms.filter((t) => haystack.includes(String(t).toLowerCase())).length;
  const relevance = terms.length ? (matched / terms.length) * 50 : 25;

  const viewsScore = Math.min(20, (Math.log10((video.views || 0) + 1) / 6) * 20);

  let recencyScore = 0;
  if (video.publishedAt) {
    const days = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = Math.max(0, 15 - Math.max(0, days - 90) / 30);
  }

  const dur = video.durationSeconds || 0;
  let usability = 15;
  if (dur < 5 || dur > 180) usability = 5;
  else if (dur < 10) usability = 10;

  return relevance + viewsScore + recencyScore + usability;
}

async function findAutopilotYoutubeSource({ accountId, productName, order = 'relevance', logPrefix = '[YouTube]' }) {
  try {
    const shared = getSystemApiSettings();
    const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      console.log(`${logPrefix} API Key 미설정 — 기존 상품 기반 글 생성으로 진행`);
      return null;
    }

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

    return {
      id: best.id,
      title: best.title,
      description: best.description,
      thumbnail: best.thumbnail || '',
      channelTitle: best.channelTitle,
      url: best.url,
      views: best.views,
      publishedAt: best.publishedAt,
      images: null,
      frames: null,
      analysis: null,
    };
  } catch (err) {
    console.log(`[YouTube] 소싱 단계 오류, 기존 자동화로 진행: ${err.message}`);
    return null;
  }
}

module.exports = { findAutopilotYoutubeSource };
