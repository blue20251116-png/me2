'use strict';
// Graceful shutdown for redeploys (Railway sends SIGTERM): stop taking requests and scheduling
// work, let an in-flight publish finish, then close SQLite cleanly. Hard exit after the grace
// period so a hung request can never block the deploy.
const cron = require('node-cron');

function installGracefulShutdown(server, { graceMs = 20000, isBusy = () => false, onClose = () => {} } = {}) {
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

    for (const task of cron.getTasks().values()) task.stop();
    server.close();
    server.closeIdleConnections?.();
    const deadline = Date.now() + graceMs - 1000;
    while (isBusy() && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
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
  return shutdown;
}

module.exports = { installGracefulShutdown };
