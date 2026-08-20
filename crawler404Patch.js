const express = require('express');

const originalHandle = express.application.handle;
const BOT_UA = /(facebookexternalhit|meta-externalagent|twitterbot)/i;

express.application.handle = function patchedHandle(req, res, callback) {
  try {
    const ua = String(req.headers?.['user-agent'] || '');
    const path = String(req.url || '').split('?')[0];
    const mediaOrApi = path.startsWith('/uploads/') || path.startsWith('/api/');

    if (BOT_UA.test(ua) && !mediaOrApi) {
      console.log(`[Crawler404] blocked ua=${ua.slice(0,120)} path=${path}`);
      res.statusCode = 404;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }
  } catch {}

  return originalHandle.call(this, req, res, callback);
};

console.log('[Crawler404 PATCH] Meta/Facebook/Twitter preview crawler 404 · /uploads 및 /api 예외');
