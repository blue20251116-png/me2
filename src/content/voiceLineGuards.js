'use strict';

// Line-break guards shared by voicePolicy.js (detection) and voiceLocalRepair.js (repair), kept in
// one place so the detector and the repairer can never drift apart.

// A line that is only a dependent connective ("so", "but", "because"…) and therefore needs the next
// line to mean anything. Words that also work as standalone replies (그치?, 그럼!, 아니!, 그래도!)
// are deliberately not listed, so a genuine one-word reaction is never treated as a broken line.
const CONNECTOR_ONLY =
  /^(?:그리고|근데|그런데|그래서|하지만|그치만|또|또는|혹은|및|그니까|그러니까|그러니깐|게다가|왜냐하면)$/;

// A line starting with punctuation that belongs to the previous line.
const DANGLING_PUNCTUATION_START = /^[!?~.…]/;

// A line starting with a bound noun / dependent expression that only works after a modifier on
// the previous line (e.g. "생각보다 작은 / 정도만 나옴", "이 가격 / 때문에 망설여짐"). Each entry must be
// followed by punctuation, a space or end of line, so ordinary words that merely start with the
// same syllable (터널, 편의점, 대로변…) are not matched.
const DANGLING_BOUND_NOUN_START =
  /^(?:뻔|만큼(?:이나|만|도|은|는)?|만한|듯(?:이)?|채(?:로)?|김에|바람에|탓에|덕분에|덕에|대신에|때문에|터(?:라|인데|였는데)|뿐|데다|셈|법|리|참|겸|대로(?:는)?|와중에|정도(?:로|까지|는|도|의|만|밖에)?|편(?:이[라야]|이다|이고|인데|이지만|임)?)(?=[!?~.…,\s]|$)/;

module.exports = { CONNECTOR_ONLY, DANGLING_PUNCTUATION_START, DANGLING_BOUND_NOUN_START };
