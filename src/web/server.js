'use strict';
const { createApp } = require('./app');
const { startPublishJob, startInsightsJob, startAutopilotJob, startStaleQueueJob } = require('../publish/scheduler');
const { startTokenRefreshJob } = require('../threads/tokenRefresh');
const { startLiveInsightsJob } = require('../threads/liveInsightsJob');
const { startThreadsDiagnosticsIfEnabled } = require('../threads/threadsCollector');

function startServer() {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  return app.listen(PORT, () => {
    console.log(`Threads 스케줄러 서버 http://localhost:${PORT}`);
    startPublishJob();
    startInsightsJob();
    startAutopilotJob();
    startStaleQueueJob();
    startTokenRefreshJob();
    startLiveInsightsJob();
    startThreadsDiagnosticsIfEnabled();
  });
}

module.exports = { startServer };
