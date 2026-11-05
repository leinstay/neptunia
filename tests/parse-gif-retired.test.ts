// `<gif>` leaves the output contract (src/llm/parse.ts): it is a retired tag, cut out and never run, and a stray one
// never turns into a message. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../src/llm/parse.ts';

test('a <gif> beside a message is cut out and told as a retired tag', () => {
  const parsed = parseOutput('<msg>κοίτα</msg><gif reply="#3">g12</gif>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['κοίτα']
  );
  assert.equal('gif' in parsed, false);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'retiredTag', tag: 'gif' }]);
});

test('an answer that is only a <gif> is silence, never a message', () => {
  const parsed = parseOutput('<gif>g12</gif>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
});

test('a <gif> in code stays the text of the message', () => {
  const parsed = parseOutput('<msg>το `<gif>g1</gif>` έφυγε</msg>');
  assert.equal(parsed.messages[0].text, 'το `<gif>g1</gif>` έφυγε');
  assert.deepEqual(parsed.diagnostics, []);
});
