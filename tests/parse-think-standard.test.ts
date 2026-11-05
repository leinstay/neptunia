// The output standard at the parser (master plan U.2, U.5; docs/prompt-contract.md): an answer whose `<think>` is broken
// comes out with no action at all and names its shape in `thinkLeak`, so the turn can ask again and nothing of it is
// sent. Nothing edits her words, so the parser never repairs such an answer: it drops it whole. `shapedThink` gives a
// reply with text and no `<think>` the empty one every stored reply carries. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, shapedThink } from '../src/llm/parse.ts';

// Bug: an answer that began inside its thinking posts its message as if nothing were wrong.
test('an answer that closes a think it never opened has no action and names the shape', () => {
  const parsed = parseOutput('σχέδιο της απάντησης</think><msg>γεια</msg>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkLeak, 'unopened');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnopened' }]);
});

// Bug: the plain-text fallback posts the thinking with its closing tag in the chat.
test('plain text with a closing think tag never falls back to a message', () => {
  const parsed = parseOutput('σχέδιο</think>γεια σου');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.untagged, false);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: the reaction of a broken answer still lands, so the answer is not dropped whole.
test('an answer with a stray closing think loses its reactions too', () => {
  const parsed = parseOutput('σχέδιο</think><react to="#3">🔥</react><react>🔥</react>');
  assert.deepEqual(parsed.reactions, []);
  assert.deepEqual(parsed.untargetedReactions, []);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: a whole think hides a second, stray closing tag later in the answer.
test('a closing think after a whole think is still a leak', () => {
  const parsed = parseOutput('<think>σχέδιο</think><msg>γεια</msg></think>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: the caller cannot tell an unclosed think from her chosen silence, so it never asks again.
test('a think never closed names the shape and keeps the old silence', () => {
  const parsed = parseOutput('<think>σχέδιο <msg>χαμένο</msg>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkOpen, true);
  assert.equal(parsed.thinkLeak, 'unclosed');
});

// Bug: every ordinary answer reads as a leak and each turn is asked twice.
test('a whole think and an answer with no think are no leak', () => {
  const whole = parseOutput('<think>σχέδιο</think><msg>γεια</msg>');
  assert.equal(whole.thinkLeak, null);
  assert.deepEqual(
    whole.messages.map((message) => message.text),
    ['γεια']
  );
  const none = parseOutput('<msg>γεια</msg>');
  assert.equal(none.thinkLeak, null);
  assert.deepEqual(
    none.messages.map((message) => message.text),
    ['γεια']
  );
});

const TAG = /<\s*\/?\s*think\b/i;
const BROKEN: ReadonlyArray<readonly [string, 'unopened' | 'unclosed']> = [
  ['<think >σχέδιο', 'unclosed'],
  ['<think >σχέδιο</think >γεια', 'unclosed'],
  ['σχέδιο</think >γεια', 'unopened'],
  ['σχέδιο</THINK>γεια', 'unopened'],
  ['<THINK>σχέδιο', 'unclosed'],
  ['<think/>γεια', 'unclosed'],
  ['<msg>γεια </think>κόσμε</msg>', 'unopened'],
  ['<msg>γεια <think>κόσμε</msg>', 'unclosed'],
  ['<msg>γεια</msg><think>', 'unclosed'],
  ['<msg>use `<think>` here</msg>', 'unclosed'],
];

for (const [raw, shape] of BROKEN) {
  // Bug: a spelling the parser's two patterns miss goes out with the tag in the chat.
  test(`no outgoing text holds a think tag for: ${raw}`, () => {
    const parsed = parseOutput(raw);
    for (const message of parsed.messages) assert.equal(TAG.test(message.text), false, message.text);
    assert.equal(parsed.thinkLeak, shape);
  });
}

// Bug: the reply with no think is stored in a different shape from every other reply.
test('shapedThink puts an empty think in front of a reply with text and no think', () => {
  assert.equal(shapedThink('<msg>γεια</msg>'), '<think></think><msg>γεια</msg>');
});

// Bug: leading white space makes a reply that has its think look like one that has none.
test('shapedThink leaves a reply that opens with its think as it is', () => {
  assert.equal(shapedThink('<think>σχέδιο</think><msg>γεια</msg>'), '<think>σχέδιο</think><msg>γεια</msg>');
  assert.equal(shapedThink('\n  <think>σχέδιο</think><msg>γεια</msg>'), '\n  <think>σχέδιο</think><msg>γεια</msg>');
});

// Bug: a tool-only answer with no text is stored as if she had written an empty reply.
test('shapedThink leaves an answer with no text empty', () => {
  assert.equal(shapedThink(''), '');
  assert.equal(shapedThink('  \n'), '  \n');
});

// Bug: the empty think makes a leaked answer look balanced to whatever reads it next.
test('shapedThink never repairs a broken answer', () => {
  assert.equal(shapedThink('σχέδιο</think><msg>γεια</msg>'), 'σχέδιο</think><msg>γεια</msg>');
  assert.equal(shapedThink('<think>σχέδιο'), '<think>σχέδιο');
});
