'use strict';
const { formatVoice, voiceProblems, assertVoice } = require('./threadsVoicePolicy');
const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);
function badStyleReasons(text, mode){return voiceProblems(text,{mode});}
function fallbackRewrite(text){return formatVoice(text);}
engine.buildThreadsFirstAutopilot = async function finalTextHardGuardBuild(accountId, options){
  const result = await originalBuild(accountId, options);
  if (!result) return result;
  result.text = assertVoice(result.text,{mode:result.mode});
  if (result.mode !== 'recipe' && result.commentLead) {
    const comment = formatVoice(result.commentLead);
    result.commentLead = voiceProblems(comment,{mode:result.mode,comment:true}).length ? '' : comment;
  }
  return result;
};
console.log('[Autopilot][TEXT HARD GUARD] source-voice-v2 shared validation; no sentence deletion');
module.exports = { badStyleReasons, fallbackRewrite };
