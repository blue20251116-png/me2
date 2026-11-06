'use strict';
// Graceful shutdown for redeploys (Railway sends SIGTERM): stop taking requests and scheduling
// work, let an in-flight publish finish, then close SQLite cleanly. Hard exit after the grace
// period so a hung request can never block the deploy.
//
// 2026-11-05 (marketing c1266546): on the Windows operating PC a restart never delivers SIGTERM
// (Stop-Process/taskkill terminate at once), which cut off #8752 mid-publish. A drain can be requested
// by creating <data dir>/shutdown.request (scripts/safe-stop.js does it and waits): the publish tick
// finishes the post in flight (onDrain stops it from claiming new ones) and the process exits 0.
// The grace is bounded (ME2_SHUTDOWN_GRACE_MS, default 180s: a video publish polls its container
// for up to ~2-3 minutes).
const fs = require('fs');
const cron = require('node-cron');

const DEFAULT_GRACE_MS = Math.max(5000, Number(process.env.ME2_SHUTDOWN_GRACE_MS) || 180000);

function installGracefulShutdown(
  server,
  {
    graceMs = DEFAULT_GRACE_MS,
    isBusy = () => false,
    onDrain = () => {},
    onClose = () => {},
    requestFile = null,
    pollMs = 2000,
  } = {}
) {
  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log(`[Shutdown] ${signal} received - draining`);
    const hardExit = setTimeout(() => {
      console.warn('[Shutdown] grace period over - forcing exit');
      process.exit(1);
    }, graceMs);
    hardExit.unref();

    try {
      onDrain();
    } catch (e) {
      console.error('[Shutdown] drain failed:', e.message);
    }
    for (const task of cron.getTasks().values()) task.stop();
    server.close();
    server.closeIdleConnections?.();
    const deadline = Date.now() + graceMs - 1000;
    if (isBusy()) console.log('[Shutdown] waiting for the in-flight publish to finish');
    while (isBusy() && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
    if (isBusy()) console.warn('[Shutdown] publish still running at the end of the grace period');
    try {
      onClose();
    } catch (e) {
      console.error('[Shutdown] close failed:', e.message);
    }
    console.log('[Shutdown] done');
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  if (process.platform === 'win32') process.once('SIGBREAK', () => shutdown('SIGBREAK'));
  if (requestFile) {
    try {
      fs.rmSync(requestFile, { force: true }); // a stale request from before this boot is not a new one
    } catch {}
    const watcher = setInterval(() => {
      if (closing || !fs.existsSync(requestFile)) return;
      clearInterval(watcher);
      try {
        fs.rmSync(requestFile, { force: true });
      } catch {}
      shutdown('DRAIN_REQUEST');
    }, pollMs);
    watcher.unref();
  }
  return shutdown;
}

module.exports = { installGracefulShutdown };
