'use strict';
const express = require('express');
const { logUsage, getSystemApiSettings } = require('../../infra/db');
const { scrapeProduct } = require('../../integrations/scraper');
const coupangApi = require('../../integrations/coupangApi');
const { generateCaption, suggestKeywordCandidates } = require('../../content/aiCaption');
const { rankKeywordsByTrend } = require('../../integrations/naverTrends');
const youtubeApi = require('../../integrations/youtubeApi');
const { requireAccount } = require('../middleware');

const router = express.Router();

// ---------- AI로 스레드 본문 자동 생성 ----------
router.post('/api/generate-caption', requireAccount, async (req, res) => {
  const { productName, price, target, youtubeSource } = req.body;
  if (!productName) return res.status(400).json({ error: 'productName이 필요합니다' });
  try {
    const texts = await generateCaption(req.account.id, { productName, price, target, youtubeSource });
    logUsage(req.currentUser.id, 'text');
    res.json({ texts });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------- AI가 검색 키워드 자체를 제안 ("AI 자동완성" 흐름) ----------
// 네이버 데이터랩 키가 연결되어 있으면 후보 5개를 실제 검색 트렌드로 비교해서 1위를 고르고,
// 없으면 AI가 제안한 후보 중 첫 번째를 그냥 사용
router.post('/api/suggest-keyword', requireAccount, async (req, res) => {
  const { target } = req.body || {};
  try {
    const candidates = await suggestKeywordCandidates(req.account.id, target);
    logUsage(req.currentUser.id, 'text');
    let keyword = candidates[0];
    let trendUsed = false;

    try {
      const ranked = await rankKeywordsByTrend(req.account.id, candidates);
      if (ranked && ranked.length) {
        keyword = ranked[0].keyword;
        trendUsed = true;
      }
    } catch (trendErr) {
      // 트렌드 조회 실패해도 AI 1순위 키워드로 그냥 진행
      console.error('[트렌드 조회 실패]', trendErr.response?.data || trendErr.message);
    }

    res.json({ keyword, candidates, trendUsed });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------- 쿠팡파트너스 상품 검색 (Open API) ----------
router.get('/api/coupang/search', requireAccount, async (req, res) => {
  const { keyword, limit } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword가 필요합니다' });
  try {
    const products = await coupangApi.searchProducts(req.account.id, keyword, Number(limit) || 10);
    res.json({ products });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

router.post('/api/coupang/deeplink', requireAccount, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const [result] = await coupangApi.createDeeplink(req.account.id, [url]);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

// ---------- YouTube 관련 짧은 영상 검색 (콘텐츠 소재 탐색용 — 다운로드 기능 아님) ----------
// YouTube Data API Key는 회원 개별 입력이 아니라 관리자 공용 설정(system_api_settings)에서만 가져온다.
// 일반 회원 응답에는 Key를 절대 포함하지 않는다.
router.get('/api/youtube/search', requireAccount, async (req, res) => {
  const { keyword, order, limit } = req.query;
  if (!keyword || !String(keyword).trim()) {
    return res.status(400).json({ error: 'keyword가 필요합니다' });
  }

  const shared = getSystemApiSettings();
  const apiKey = shared.youtube_api_key || process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(422).json({ error: '관리자가 YouTube Data API Key를 아직 설정하지 않았습니다.' });
  }

  try {
    const videos = await youtubeApi.searchVideos({
      apiKey,
      keyword,
      order: order || 'relevance',
      maxResults: Number(limit) || 10,
    });
    if (!videos.length) {
      return res.json({ videos: [], message: '관련 영상을 찾지 못했습니다. 검색어를 조금 다르게 입력해보세요.' });
    }
    res.json({ videos });
  } catch (err) {
    const reason = err.response?.data?.error?.errors?.[0]?.reason || '';
    if (err.response?.status === 403 && /quota/i.test(reason)) {
      return res.status(429).json({ error: 'YouTube API 사용량 한도에 도달했습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (err.response) {
      return res.status(422).json({ error: err.response?.data?.error?.message || err.message });
    }
    console.error('[YouTube 검색 오류]', err.message);
    res.status(500).json({ error: 'YouTube 검색 중 오류가 발생했습니다.' });
  }
});

// ---------- 상품 이미지/제목 자동 가져오기 (검색 API를 못 쓸 때의 보조 수단) ----------
router.post('/api/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
