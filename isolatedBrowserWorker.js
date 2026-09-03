'use strict';
require('./httpDeadline');
process.once('message', async ({ moduleName, method, args, accountId }) => {
  try {
    const allowed = {
      benchmarkAccounts: ['collectBenchmarkMaterials', 'collectPostDetails', 'collectProfilePosts'],
      threadsMediaImporter: ['importThreadsVideo', 'extractCandidatesWithBrowser'],
      sourceAffiliateExactProductPatch: ['resolveWithBrowser'],
      autopilotVideoTriggerPatch: ['detectThreadsVideo'],
    };
    if (!allowed[moduleName]?.includes(method)) throw new Error('Unsupported browser task');
    global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
    require('./threadsSourceMediaExactPatch');
    require('./accountScopedMaterialPatch');
    require('./threadsVideoIntegrityPatch');
    if (moduleName === 'benchmarkAccounts') {
      require('./threadsVideoPatch');
      require('./threadsTextFallbackPatch');
    }
    const value = await require(`./${moduleName}`)[method](...args);
    process.send({ ok: true, value });
  } catch (err) {
    process.send({ ok: false, error: { message: err.message, code: err.code } });
  }
});
