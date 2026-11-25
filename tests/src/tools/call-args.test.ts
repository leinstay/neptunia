// Tests for the persona's previous think in a request (src/behavior/prompt.ts#buildRequest, `<previous_think>`) and
// the main arguments of a call on its transcript line (src/tools/call-args.ts, src/format.ts#callMarksFor). The store
// that chooses the think is tested in tests/src/behavior/previous-think.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callArgsText } from '../../../src/tools/call-args.ts';

// --- the arguments of a call on its line ----------------------------------

// An argument of a call is kept whole; the limits of 60 and 160 are gone.
test("callArgsText: the skill's main arguments, one line, quoted, whole, never a secret field", () => {
  assert.equal(
    callArgsText('web.search', { query: 'tulip bulbs\nin autumn', goal: 'plan', extra: 'x' }),
    'query: "tulip bulbs in autumn", goal: "plan"'
  );
  // Slice 7: the tool argument `channel` is named `place`.
  assert.equal(callArgsText('conversation.read', { place: 'general', last: 20 }), 'place: "general", last: 20');
  assert.equal(
    callArgsText('web.search', { query: 'a'.repeat(300), goal: 'b'.repeat(300) }),
    `query: "${'a'.repeat(300)}", goal: "${'b'.repeat(300)}"`
  );
  assert.equal(callArgsText('config.set', { path: 'x', value: 'sk-secret' }), '');
  assert.equal(callArgsText('web.read', { url: 'https://e.test/a]b<c>' }), 'url: "https://e.test/a b c"');
  assert.equal(callArgsText('message.create', { text: 'hello', place: 'general' }), '');
  assert.equal(callArgsText('web.search', null), '');
});
