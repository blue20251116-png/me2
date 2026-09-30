'use strict';
const axios = require('axios');
if (!axios.__me2Deadline) {
  axios.__me2Deadline = true;
  axios.interceptors.request.use(config => {
    const configured = Number(config.timeout);
    const timeout = configured > 0 && Number.isFinite(configured) ? Math.min(configured,120000) : 30000;
    config.timeout = timeout;
    const deadline = AbortSignal.timeout(timeout);
    config.signal = config.signal ? AbortSignal.any([config.signal,deadline]) : deadline;
    return config;
  });
}
