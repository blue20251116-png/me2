'use strict';

// Safely pre-generate up to 10 posts per account and schedule them at future times.
// This patch edits scheduler.js before it is loaded so generation and publishing remain separated:
// - generator creates complete posts with an explicit future scheduled_at
// - publisher keeps its existing `scheduled_at <= now` rule and publishes only when due
// - no generated post is intentionally scheduled for `now`

const fs = require('fs');
const path = require('path');
const Module = require('module');

if (!global.__ME2_TIMED_PREFILL_PATCH__) {
  global.__ME2_TIMED_PREFILL_PATCH__ = true;

  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function timedPrefillLoader(mod, filename) {
    if (!filename.endsWith(`${path.sep}scheduler.js`)) return originalJs(mod, filename);

    let source = fs.readFileSync(filename, 'utf8');

    // 1) Allow the existing post builder to receive an explicit future schedule.
    source = source.replace(
      'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null}){',
      'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null,scheduledAt=null}){'
    );
    source = source.replace(
      "new Date().toISOString(),accountId,recipeCommentText);}",
      "String(scheduledAt||new Date().toISOString()),accountId,recipeCommentText);}"
    );

    // 2) Thread scheduledAt through both generation paths.
    source = source.replace(
      'async function runContentOnlyAutopilot(account,target){',
      'async function runContentOnlyAutopilot(account,target,scheduledAt=null){'
    );
    source = source.replace(
      'recipeCommentText:r.recipeCommentText});recordAutopilotLast',
      'recipeCommentText:r.recipeCommentText,scheduledAt});recordAutopilotLast'
    );
    source = source.replace(
      'async function runAutopilotOnce(account){',
      'async function runAutopilotOnce(account,scheduledAt=null){'
    );
    source = source.replace(
      'await runContentOnlyAutopilot(account,target);return;',
      'await runContentOnlyAutopilot(account,target,scheduledAt);return;'
    );
    source = source.replace(
      'recipeCommentText:result.commentLead});const last=',
      'recipeCommentText:result.commentLead,scheduledAt});const last='
    );

    // 3) Export one-shot generator for the timed queue controller.
    source = source.replace(
      'module.exports={startPublishJob,startInsightsJob,startAutopilotJob};',
      'module.exports={startPublishJob,startInsightsJob,startAutopilotJob,runAutopilotOnce};'
    );

    mod._compile(source, filename);
  };

  console.log('[Autopilot][TIMED PREFILL] scheduler future-time generation hook enabled');
}
