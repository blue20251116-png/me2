'use strict';

// Shared by threadsVoicePolicy.js (detection) and threadsVoiceLocalRepair.js
// (repair) so the two stay in sync. These used to be copy-pasted in both
// files; the repair copy silently fell behind when DANGLING_BOUND_NOUN_START
// was widened to catch 만큼/정도 with a trailing particle (commit 0df363b),
// so repairConnectorOnlyBreaks() stopped being able to fix the very cases the
// detector was newly flagging.
const CONNECTOR_ONLY = /^(?:그리고|근데|그래서|하지만|또|또는|혹은|및)$/;
const DANGLING_PUNCTUATION_START = /^[!?~.…]/;
const DANGLING_BOUND_NOUN_START = /^(?:뻔|만큼(?:이나|만|도|은|는)?|듯|채(?:로)?|김에|바람에|탓에|터라|뿐|데다|셈|법|리|참|겸|정도(?:로|까지|는|도|의)?)(?=[!?~.…,\s]|$)/;

module.exports = { CONNECTOR_ONLY, DANGLING_PUNCTUATION_START, DANGLING_BOUND_NOUN_START };
