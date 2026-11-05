// The `<react>` boundary of the output contract (src/llm/parse.ts#parseOutput), the way #567 gave `<msg>` one: a reaction
// is the emoji between its own tags and nothing else. A tag of another action never lands in the emoji, a reaction's tag
// never lands in a message, an opening `<react>` while another is open ends that one there, and a tag example in code
// is text, never an action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../src/llm/parse.ts';

test('a message inside a reaction stays a message and the emoji is the emoji alone', () => {
  const parsed = parseOutput('<react to="#5">🔥<msg>hello</msg></react>');
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
  assert.deepEqual(parsed.messages, [{ text: 'hello', replyTo: null }]);
});

test('a reaction written inside a message acts and is not sent as the message words', () => {
  const parsed = parseOutput('<msg>hello <react to="#5">🔥</react></msg>');
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
  assert.deepEqual(parsed.messages, [{ text: 'hello', replyTo: null }]);
});

test('an opening <react> inside an open reaction ends it there, so the inner reaction acts', () => {
  const parsed = parseOutput('<react to="#1"><react to="#2">🔥</react>');
  assert.deepEqual(parsed.reactions, [{ to: 2, emoji: '🔥' }]);
});

test('a reaction example in code is no reaction and stays in the message as typed', () => {
  const parsed = parseOutput('<msg>type `<react to="#5">🔥</react>` to react</msg>');
  assert.deepEqual(parsed.reactions, []);
  assert.deepEqual(parsed.messages, [{ text: 'type `<react to="#5">🔥</react>` to react', replyTo: null }]);
});
