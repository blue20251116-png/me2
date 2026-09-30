'use strict';
// Child process that runs one Playwright task and exits (see isolatedTask.js). The parent forks
// it with an empty execArgv, so it sets up its own HTTP deadline and Chromium launch guard first.
require('./httpDeadline');
require('./browserLauncher');

// Only these module methods may be invoked from the parent. Keys are stable task names.
const TASKS = {
  benchmarkAccounts: { path: '../threads/benchmarkAccounts', methods: ['collectBenchmarkMaterials', 'collectPostDetails', 'collectProfilePosts'] },
  mediaImporter: { path: '../threads/mediaImporter', methods: ['importThreadsVideo', 'extractCandidatesWithBrowser'] },
  sourceExactProduct: { path: '../autopilot/stages/sourceExactProduct', methods: ['resolveWithBrowser'] },
  videoTrigger: { path: '../autopilot/stages/videoTrigger', methods: ['detectThreadsVideo'] },
};

process.once('message', async ({ moduleName, method, args, accountId }) => {
  try {
    const task = TASKS[moduleName];
    if (!task?.methods.includes(method)) throw new Error('Unsupported browser task');
    global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
    const value = await require(task.path)[method](...args);
    process.send({ ok: true, value });
  } catch (err) {
    process.send({ ok: false, error: { message: err.message, code: err.code } });
  }
});
