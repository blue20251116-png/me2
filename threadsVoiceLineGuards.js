'use strict';

// Shared by threadsVoicePolicy.js (detection) and threadsVoiceLocalRepair.js
// (repair) so the two stay in sync. These used to be copy-pasted in both
// files; the repair copy silently fell behind when DANGLING_BOUND_NOUN_START
// was widened to catch 만큼/정도 with a trailing particle (commit 0df363b),
// so repairConnectorOnlyBreaks() stopped being able to fix the very cases the
// detector was newly flagging.
// 그니까/그러니까 (casual/formal "so"/"that's why") are grammatically dependent connectives
// just like 그래서/근데, always requiring a following clause - never a complete standalone
// utterance. Deliberately NOT adding 그치/그럼/아니: those are also common connector-shaped
// words but each one doubles as a genuine standalone interjection on its own line ("그치?" =
// "right?", "그럼!" = "of course!", "아니!" = "no way!"), so flagging them would risk rejecting
// a real complete thought as a mid-phrase split.
// REGRESSION (found via synthetic testing, hourly review, 2026-09-13): "그런데" is the exact same
// word as "근데" (only more formal in register) and is at least as common, but wasn't listed -
// a bare "그런데" line went completely unflagged even though it needs a following clause exactly
// like "근데" already does. "그러니깐" is likewise just a third common spelling of "그니까"/
// "그러니까", already both in this list.
const CONNECTOR_ONLY = /^(?:그리고|근데|그런데|그래서|하지만|또|또는|혹은|및|그니까|그러니까|그러니깐)$/;
const DANGLING_PUNCTUATION_START = /^[!?~.…]/;
// REGRESSION (found via synthetic testing, hourly review, 2026-09-13): three more everyday
// dependent bound nouns were missing entirely, so a model splitting "이 국물은 좀 순한 / 편이라
// 아이도 잘 먹음", "생각보다 훨씬 큰 / 만한 사이즈였음", or "이거 써보니까 / 듯이 편해짐" across two
// lines went completely undetected - each continuation line is grammatically incomplete without
// the modifier on the line before it, exactly the shape this guard exists to catch, but none of
// 편/만한/듯이 were in the list. "듯" was already covered but only the bare form - "듯이" (with the
// adverbial 이) is at least as common and didn't match because the old pattern's lookahead
// required punctuation/space/end to follow "듯" directly.
const DANGLING_BOUND_NOUN_START = /^(?:뻔|만큼(?:이나|만|도|은|는)?|만한|듯(?:이)?|채(?:로)?|김에|바람에|탓에|터라|뿐|데다|셈|법|리|참|겸|정도(?:로|까지|는|도|의)?|편(?:이[라야]|이다|이고|인데|이지만|임)?)(?=[!?~.…,\s]|$)/;

module.exports = { CONNECTOR_ONLY, DANGLING_PUNCTUATION_START, DANGLING_BOUND_NOUN_START };
