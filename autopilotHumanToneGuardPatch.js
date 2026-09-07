'use strict';

// Legacy compatibility shim.
// Threads writing persona, line length, paragraph rhythm and final semantic repair
// are owned exclusively by threadsVoicePolicy.js. Keeping a second writer here
// previously caused conflicting 52-char/3-6-line/reaction-forcing rewrites.
const engine = require('./autopilotMaterialEngine');
const { formatVoice } = require('./threadsVoicePolicy');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

engine.buildThreadsFirstAutopilot = async function(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  return { ...result, text: formatVoice(result.text) };
};

console.log('[AutopilotV3][HUMAN FINAL] legacy persona disabled; threadsVoicePolicy is sole voice authority');

module.exports = { engine };
