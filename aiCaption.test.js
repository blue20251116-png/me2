'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSystemPrompt } = require('./aiCaption');
const { PERSONAS } = require('./threadsPersonas');

// Found via review: makeSystemPrompt() inserts voiceGuide(personaBlock) (which, for the
// curiosity persona, explicitly forbids revealing the product/topic in the opening line) and
// then, later in the SAME system prompt, shows a fixed "[좋은 문체 예시]" block whose every
// example reveals the topic immediately in line 1 ("이런 코트 하나 보고 있는데", "맨날 충전선
// 책상 밑으로 떨어져서", ...). A model given both could reasonably follow the concrete worked
// examples over the abstract persona rule, silently defeating the curiosity persona (and the
// housewife-recipe/trainer-expert/parenting-mom personas' own required opening shapes) for this
// specific caption tool. This test locks in the fix: an explicit priority sentence between the
// persona block and the examples, telling the model the persona's structural rules win.
test('makeSystemPrompt tells the model the assigned persona wins over the generic style examples', () => {
  const curiosity = PERSONAS.find(p => p.id === 'curiosity');
  const prompt = makeSystemPrompt(curiosity.block);

  const personaIndex = prompt.indexOf(curiosity.block);
  const priorityNoteIndex = prompt.indexOf('위 페르소나 지시를 따르고');
  const examplesIndex = prompt.indexOf('[좋은 문체 예시]');

  assert.ok(personaIndex >= 0, 'the persona block itself must be present in the prompt');
  assert.ok(priorityNoteIndex >= 0, 'a priority-clarifying note must be present');
  assert.ok(examplesIndex >= 0, 'the generic style examples section must be present');
  // Ordering matters: the model must read the persona, then the priority note, before it ever
  // reaches the examples that would otherwise look like the stronger, more concrete instruction.
  assert.ok(personaIndex < priorityNoteIndex, 'persona block must come before the priority note');
  assert.ok(priorityNoteIndex < examplesIndex, 'priority note must come before the examples it overrides');
});

test('makeSystemPrompt still works with no persona argument (default reaction persona)', () => {
  const prompt = makeSystemPrompt();
  assert.ok(prompt.includes('[캐릭터 강도'));
  assert.ok(prompt.includes('[좋은 문체 예시]'));
});
