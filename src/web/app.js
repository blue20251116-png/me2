'use strict';
// Builds the Express app. Order matters: public routes → session → login-free routes →
// /uploads (Meta fetches media without cookies) → auth gate → everything else.
const express = require('express');
const path = require('path');
const session = require('express-session');
const { PUBLIC_DIR } = require('../config/paths');
const SQLiteSessionStore = require('../infra/sessionStore');
const { bootstrapAdmin } = require('../infra/db');
const { requireAuth } = require('./auth');
const { uploadsDir } = require('./middleware');

// bootstrapAdmin() writes to the users table; on a full disk it must not crash the boot.
try {
  bootstrapAdmin();
} catch (e) {
  console.error('[Server][INIT] bootstrapAdmin 실패 (디스크 문제로 추정) - 프로세스는 계속 부팅합니다:', e.message);
}

function createApp() {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET)
    throw new Error('SESSION_SECRET is required in production');
  const app = express();

  // Link-preview crawlers get a 404 for pages (keeps the dashboard out of previews) but can
  // still fetch /uploads media and API responses.
  const CRAWLER_BOT_UA = /(facebookexternalhit|meta-externalagent|twitterbot)/i;
  app.use((req, res, next) => {
    const ua = String(req.headers?.['user-agent'] || '');
    const urlPath = String(req.url || '').split('?')[0];
    const mediaOrApi = urlPath.startsWith('/uploads/') || urlPath.startsWith('/api/');
    if (CRAWLER_BOT_UA.test(ua) && !mediaOrApi) {
      console.log(`[Crawler404] blocked ua=${ua.slice(0, 120)} path=${urlPath}`);
      res.statusCode = 404;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Not Found');
    }
    next();
  });
  app.disable('x-powered-by');
  app.use(require('./securityHeaders'));
  app.use(express.json({ limit: '1mb' }));
  app.set('trust proxy', 1); // Railway 등 프록시 뒤에서 세션 쿠키가 정상 동작하도록

  app.use(require('./routes/system')); // /healthz, /admin/emergency-cleanup (must work without DB/session)

  app.use(
    session({
      store: new SQLiteSessionStore(),
      secret: process.env.SESSION_SECRET || 'threads-scheduler-dev-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
        secure: process.env.NODE_ENV === 'production',
      },
    })
  );

  // ---------- 공개 라우트 (로그인 없이 접근 가능) ----------
  app.use(express.static(PUBLIC_DIR, { index: false }));
  for (const page of ['login.html', 'signup.html', 'status.html'])
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(PUBLIC_DIR, page)));
  app.use(require('./routes/auth'));

  // Threads API requires public media URLs, so /uploads is served before the auth gate.
  app.use('/uploads', express.static(uploadsDir));

  // ---------- 여기부터는 로그인 + 승인(active) 상태여야만 통과 ----------
  app.use(requireAuth);
  app.use(require('./routes/admin'));
  app.use(express.static(PUBLIC_DIR)); // index.html(대시보드)은 인증 통과 후에만
  app.use(require('./routes/accounts'));
  app.use(require('./routes/media'));
  app.use(require('./routes/content'));
  app.use(require('./routes/posts'));
  app.use(require('./routes/threads'));
  return app;
}

module.exports = { createApp };
