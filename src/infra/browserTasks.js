'use strict';
// Registry of Playwright tasks that may run inside the isolated browser worker. Only these module
// methods can be invoked across the process boundary. Modules are required lazily so the parent
// process never loads browser code it doesn't run.
const TASKS = {
  threadsScraper: {
    path: '../threads/threadsScraper',
    methods: [
      'collectBenchmarkMaterials',
      'collectPostDetails',
      'collectProfilePosts',
      'extractPlayableVideoUrls',
      'videoFallbackFromProfile',
      'runThreadsAccessDiag',
    ],
  },
  mediaImporter: {
    path: '../threads/mediaImporter',
    methods: ['importThreadsVideoInBrowser', 'extractCandidatesInBrowser'],
  },
  sourceExactProduct: { path: '../autopilot/stages/sourceExactProduct', methods: ['resolveInBrowser'] },
  videoTrigger: { path: '../autopilot/stages/videoTrigger', methods: ['detectThreadsVideoInBrowser'] },
};

function runTask(moduleName, method, args = []) {
  const task = TASKS[moduleName];
  if (!task?.methods.includes(method)) throw new Error('Unsupported browser task');
  return require(task.path)[method](...args);
}

module.exports = { TASKS, runTask };
