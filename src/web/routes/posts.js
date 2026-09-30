'use strict';
const express = require('express');
const { db, saveMediaSource } = require('../../infra/db');
const { requireAccount } = require('../middleware');

const router = express.Router();

// ---------- 글 등록 (예약) ----------
router.post('/api/posts', requireAccount, (req, res) => {
  const {
    text,
    link,
    image_url,
    extra_image_url,
    video_url,
    scheduled_at,
    auto_comment_enabled,
    product_name,
    frame_job_id,
  } = req.body;
  if (!text || !scheduled_at) {
    return res.status(400).json({ error: 'text와 scheduled_at은 필수입니다' });
  }
  const info = db
    .prepare(
      `INSERT INTO posts (account_id, text, link, image_url, extra_image_url, video_url, scheduled_at, auto_comment_enabled, comment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.account.id,
      text,
      link || null,
      image_url || null,
      // 영상이 있으면 2번째 이미지(캐러셀)는 의미가 없으니 무시
      video_url ? null : extra_image_url || null,
      video_url || null,
      scheduled_at,
      auto_comment_enabled === false ? 0 : 1,
      link ? 'pending' : 'none'
    );

  // 영상 프레임(+상품 이미지) 조합으로 게시한 경우, 나중에 완전자동화가 비슷한 상품을 고를 때
  // 재사용할 수 있도록 이 조합을 최소한으로 기억해둔다 (선택 사항 — 프레임을 안 썼으면 아무 일도 안 함).
  if (product_name && frame_job_id && image_url) {
    try {
      saveMediaSource(req.account.id, {
        productName: product_name,
        frameJobId: frame_job_id,
        imageUrl: image_url,
        extraImageUrl: extra_image_url || null,
      });
    } catch (err) {
      console.log('[Media] media_source 저장 실패(게시 자체는 정상 진행):', err.message);
    }
  }

  res.json({ id: info.lastInsertRowid });
});

router.delete('/api/posts/:id', requireAccount, (req, res) => {
  db.prepare(`DELETE FROM posts WHERE id = ? AND account_id = ? AND status = 'pending'`).run(
    req.params.id,
    req.account.id
  );
  res.json({ ok: true });
});

// ---------- 대시보드용 요약 데이터 ----------
router.get('/api/dashboard', requireAccount, (req, res) => {
  const accountId = req.account.id;
  // "Today" and the hourly chart are KST, not server-local time (Railway runs in UTC, which made
  // "today" run 09:00-09:00 KST and shifted every hourly bar by 9 hours).
  const kstDayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const startOfDay = new Date(`${kstDayKey}T00:00:00+09:00`);
  const kstHour = iso => (new Date(iso).getUTCHours() + 9) % 24;
  const startIso = startOfDay.toISOString();
  const endOfDay = new Date(startOfDay.getTime() + 24 * 3600 * 1000).toISOString();

  const pendingToday = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .get(accountId, startIso, endOfDay).c;

  const postedToday = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? AND status = 'posted' AND posted_at >= ? AND posted_at < ?`)
    .all(accountId, startIso, endOfDay);

  const totalScheduled = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND status != 'failed'`
    )
    .get(accountId, startIso, endOfDay).c;

  const postIds = postedToday.map(p => p.id);
  let totalViews = 0;
  const insightsByPost = {};
  if (postIds.length) {
    const placeholders = postIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM insights WHERE post_id IN (${placeholders})`).all(...postIds);
    for (const r of rows) {
      totalViews += r.views || 0;
      insightsByPost[r.post_id] = r;
    }
  }

  const next = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? AND status = 'pending' ORDER BY scheduled_at ASC LIMIT 1`)
    .get(accountId);

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, views: 0 }));
  for (const p of postedToday) {
    const h = kstHour(p.posted_at);
    hourly[h].count += 1;
    hourly[h].views += insightsByPost[p.id]?.views || 0;
  }
  const pendingRows = db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .all(accountId, startIso, endOfDay);
  for (const p of pendingRows) {
    const h = kstHour(p.scheduled_at);
    hourly[h].count += 1;
  }

  res.json({
    pendingToday,
    postedTodayCount: postedToday.length,
    totalScheduled,
    totalViews,
    nextPost: next || null,
    hourly,
    postedToday: postedToday.map(p => ({ ...p, insights: insightsByPost[p.id] || null })),
  });
});

router.get('/api/posts', requireAccount, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? ORDER BY scheduled_at DESC LIMIT 200`)
    .all(req.account.id);
  res.json(rows);
});

module.exports = router;
