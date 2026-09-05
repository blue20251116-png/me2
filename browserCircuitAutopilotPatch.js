'use strict';
const Module = require('module');
const { getBrowserCircuitState, browserInfraFailure } = require('./isolatedTask');

// Prevent one Chromium resource failure from being multiplied across every
// account in the same refill tick. This wraps scheduler.runAutopilotOnce at
// the module boundary, so the existing timed-prefill controller receives a
// distinct fatal-for-this-tick error and can stop account traversal.
if (!global.__ME2_BROWSER_CIRCUIT_AUTOPILOT_PATCH__) {
  global.__ME2_BROWSER_CIRCUIT_AUTOPILOT_PATCH__ = true;
  const originalLoad = Module._load;
  Module._load = function browserCircuitAutopilotLoad(request, parent, isMain) {
    const exp = originalLoad.apply(this, arguments);
    if (!['./scheduler','./scheduler.js'].includes(request) || !exp || exp.__browserCircuitAutopilotPatched) return exp;
    if (typeof exp.runAutopilotOnce === 'function') {
      const original = exp.runAutopilotOnce.bind(exp);
      exp.runAutopilotOnce = async function browserAwareAutopilotOnce(...args) {
        const state = getBrowserCircuitState();
        if (state.open) {
          const err = new Error(`Browser circuit open; retry after ${state.retryAfterMs}ms`);
          err.code = 'BROWSER_CIRCUIT_OPEN'; err.retryAfterMs = state.retryAfterMs; throw err;
        }
        try { return await original(...args); }
        catch (err) {
          if (browserInfraFailure(err)) {
            err.code = err.code || 'BROWSER_INFRA_FAILURE';
            err.stopAutopilotTick = true;
          }
          throw err;
        }
      };
    }
    exp.__browserCircuitAutopilotPatched = true;
    return exp;
  };
  console.log('[Autopilot][BROWSER CIRCUIT] scheduler guard armed');
}
