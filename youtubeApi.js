const axios = require('axios');

// YouTube 콘텐츠 소싱 전용 모듈.
// 여기서는 영상을 절대 다운로드하지 않고, YouTube Data API v3의 검색/상세조회 결과를
// 프론트에서 바로 쓸 수 있게 정규화해서 돌려주는 역할만 한다.
// API Key는 호출하는 쪽(server.js)에서 관리자 공용 설정을 읽어 넘겨준다 — 이 파일은 Key를
// 저장하거나 로그로 남기지 않는다.

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

const VALID_ORDERS = ['relevance', 'viewCount', 'date'];

// ISO 8601 duration(예: "PT1M5S", "PT21S")을 초로 변환.
// 초 단위 변환과 "1분 5초" 같은 한국어 표기는 여기 한 곳에서만 처리한다(중복 방지).
function parseISODurationToSeconds(iso) {
  if (!iso) return 0;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// 초 단위를 "1시간 5분" / "1분 5초" / "21초" 같은 한국어 표기로 변환
function formatDurationKorean(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return sec > 0 ? `${m}분 ${sec}초` : `${m}분`;
  return `${sec}초`;
}

// high -> medium -> default 순서로 사용 가능한 썸네일을 고른다
function pickThumbnail(thumbnails) {
  if (!thumbnails) return '';
  return thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';
}

// 상품명으로 관련 짧은 영상을 검색한다.
// 참고: YouTube API의 videoDuration=short는 "짧은 영상"이라는 뜻이지 "YouTube Shorts만"을
// 의미하지 않는다 — 호출하는 쪽에서 "쇼츠만 검색"이라고 단정해서 표현하지 않도록 주의할 것.
async function searchVideos({ apiKey, keyword, order = 'relevance', maxResults = 10 }) {
  if (!apiKey) throw new Error('YouTube API Key가 없습니다');
  if (!keyword || !String(keyword).trim()) throw new Error('검색어가 필요합니다');

  const safeOrder = VALID_ORDERS.includes(order) ? order : 'relevance';
  const safeMax = Math.min(Math.max(Number(maxResults) || 10, 1), 12);

  const searchRes = await axios.get(SEARCH_URL, {
    params: {
      key: apiKey,
      part: 'snippet',
      type: 'video',
      q: String(keyword).trim(),
      maxResults: safeMax,
      videoDuration: 'short',
      order: safeOrder,
      safeSearch: 'moderate',
    },
    timeout: 10000,
  });

  const videoIds = (searchRes.data?.items || []).map((it) => it.id?.videoId).filter(Boolean);
  if (!videoIds.length) return [];

  const videosRes = await axios.get(VIDEOS_URL, {
    params: {
      key: apiKey,
      part: 'snippet,contentDetails,statistics',
      id: videoIds.join(','),
    },
    timeout: 10000,
  });

  const items = videosRes.data?.items || [];

  // search 결과 순서(정렬 기준 반영)를 그대로 유지하기 위해 videoIds 순서대로 정렬해서 반환
  const byId = new Map(items.map((v) => [v.id, v]));
  return videoIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((v) => {
      const durationSeconds = parseISODurationToSeconds(v.contentDetails?.duration);
      return {
        id: v.id,
        title: v.snippet?.title || '',
        description: v.snippet?.description || '',
        thumbnail: pickThumbnail(v.snippet?.thumbnails),
        channelTitle: v.snippet?.channelTitle || '',
        publishedAt: v.snippet?.publishedAt || '',
        duration: formatDurationKorean(durationSeconds),
        durationSeconds,
        views: Number(v.statistics?.viewCount || 0),
        url: `https://www.youtube.com/watch?v=${v.id}`,
      };
    });
}

module.exports = {
  searchVideos,
  formatDurationKorean,
  parseISODurationToSeconds,
};
