'use strict';
const { formatVoice, voiceProblems, assertVoice } = require('./threadsVoicePolicy');
const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);
function badStyleReasons(text, mode){return voiceProblems(text,{mode});}
function fallbackRewrite(text){return formatVoice(text);}
// voiceProblems(..., {comment:true}) already skips every structural check (line count,
// dangling-line splits, CTA ending) and ONLY runs highRiskClaim() - so this is exactly as safe
// for a recipe's "🥘 재료 / 🍳 만드는 법" comment as for any other comment. This used to only run
// for `mode !== 'recipe'`, which also threw out the one check that still applied under
// comment:true, leaving a recipe's ingredient/steps text with zero health-claim screening -
// confirmed a synthetic case ("이 소스 매일 먹으면 염증이 나아서") slipped through untouched.
function guardCommentLead(commentLead, mode){
  if (!commentLead) return commentLead;
  const comment = formatVoice(commentLead);
  return voiceProblems(comment,{mode,comment:true}).length ? '' : comment;
}
engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options){
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  result.text = assertVoice(result.text,{mode:result.mode});
  result.commentLead = guardCommentLead(result.commentLead, result.mode);
  return result;
};
console.log('[Autopilot][TEXT HARD GUARD] source-voice-v2 shared validation; no sentence deletion');
module.exports = { badStyleReasons, fallbackRewrite, guardCommentLead };
