'use strict';
const { createApp } = require('./app');
const { startPublishJob, startInsightsJob, startStaleQueueJob } = require('../publish/scheduler');
const { startAutopilotJob } = require('../autopilot/runner');
const { startTokenRefreshJob } = require('../threads/tokenRefresh');
const { startLiveInsightsJob } = require('../threads/liveInsightsJob');
const { startThreadsDiagnosticsIfEnabled } = require('../threads/threadsCollector');
const { installGracefulShutdown } = require('./shutdown');

function startServer() {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`Threads 스케줄러 서버 http://localhost:${PORT}`);
    startPublishJob();
    startInsightsJob();
    startAutopilotJob();
    startStaleQueueJob();
    startTokenRefreshJob();
    startLiveInsightsJob();
    startThreadsDiagnosticsIfEnabled();
  });
  installGracefulShutdown(server, {
    isBusy: require('../publish/publishQueue').isPublishing,
    onClose: () => {
      require('../infra/isolatedTask').killAllWorkers();
      require('../infra/db').db.close();
    },
  });
  return server;
}

module.exports = { startServer };
