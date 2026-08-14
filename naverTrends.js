const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

// 네이버 데이터랩 검색어 트렌드 API
// - 후보 키워드 최대 5개를 한 번에 비교해서, 최근 검색량 지수가 가장 높은 키워드를 골라준다
// - 절대 검색량이 아니라 "상대 비율(0~100)"만 나온다는 게 데이터랩 API의 한계
async function rankKeywordsByTrend(accountId, keywords) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  const clientId = shared.naver_client_id || process.env.NAVER_CLIENT_ID || account?.naver_client_id;
  const clientSecret = shared.naver_client_secret || process.env.NAVER_CLIENT_SECRET || account?.naver_client_secret;
  if (!clientId || !clientSecret) {
    return null; // 운영자 공용 네이버 API 미설정 - 트렌드 비교 없이 넘어감
  }
  if (!keywords.length) return null;

  const candidates = keywords.slice(0, 5); // 데이터랩은 keywordGroups 최대 5개까지만 허용

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const res = await axios.post(
    'https://openapi.naver.com/v1/datalab/search',
    {
      startDate,
      endDate,
      timeUnit: 'date',
      keywordGroups: candidates.map((kw) => ({ groupName: kw, keywords: [kw] })),
    },
    {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  // 각 키워드 그룹의 최근 3일 평균 비율로 순위 매김 (당일치 하루만 보면 튀는 값이 있을 수 있어서)
  const ranked = (res.data.results || [])
    .map((group) => {
      const recent = (group.data || []).slice(-3);
      const avg = recent.length ? recent.reduce((s, d) => s + d.ratio, 0) / recent.length : 0;
      return { keyword: group.title, avgRatio: avg };
    })
    .sort((a, b) => b.avgRatio - a.avgRatio);

  return ranked;
}

module.exports = { rankKeywordsByTrend };
