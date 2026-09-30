'use strict';
const axios = require('axios');

// Every outgoing axios request gets a hard deadline (default 30s, max 120s) enforced by an
// AbortSignal, so a stalled DNS/TCP/TLS handshake can never hang a scheduler tick forever.
function installHttpDeadline() {
  if (axios.__me2Deadline) return;
  axios.__me2Deadline = true;
  axios.interceptors.request.use(config => {
    const configured = Number(config.timeout);
    const timeout = configured > 0 && Number.isFinite(configured) ? Math.min(configured, 120000) : 30000;
    config.timeout = timeout;
    const deadline = AbortSignal.timeout(timeout);
    config.signal = config.signal ? AbortSignal.any([config.signal, deadline]) : deadline;
    return config;
  });
}

module.exports = { installHttpDeadline };
