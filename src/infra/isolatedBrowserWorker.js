'use strict';
// Child process that runs one Playwright task from browserTasks.js and exits (see isolatedTask.js).
// Task modules launch Chromium through infra/browserLauncher.launchChromium().
require('./httpDeadline').installHttpDeadline();
const { runTask } = require('./browserTasks');

process.once('message', async ({ moduleName, method, args, accountId }) => {
  try {
    global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
    const value = await runTask(moduleName, method, args);
    process.send({ ok: true, value });
  } catch (err) {
    process.send({ ok: false, error: { message: err.message, code: err.code } });
  }
});
