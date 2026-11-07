// Tests for src/behavior/inner-output.ts: the output tags of an inner turn lowered into the
// calls a message.create / message.react.add of hers would be, in the order an addressed turn acts
// in, and the ones that must be refused carry their code. A picture is a tool call, never lowered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerOutputCalls } from '../src/behavior/inner-output.ts';
import { wrongly } from './fixtures/loose-types.ts';

const parsed = {
  reactions: [{ to: 2, emoji: '👍' }],
  untargetedReactions: [{ emoji: '🔥' }],
  messages: [
    { text: 'πρώτο', replyTo: 3 },
    { text: 'δεύτερο', replyTo: null },
  ],
  // A leftover picture tag is not lowered: a picture is the draw.create tool.
  draw: { text: 'a boat', self: true, replyTo: 4 },
};

// B7: `<gif>` left her output, so an inner turn lowers reactions and messages.
test('innerOutputCalls: reactions and messages, in that order, and no picture, each as the call it stands for', () => {
  const calls = innerOutputCalls(parsed, { current: 'c1', turnChannel: 'c1' });
  assert.deepEqual(calls, [
    { skill: 'message.react.add', args: { message: '#2', emoji: '👍' } },
    { skill: 'message.react.add', args: { emoji: '🔥' }, refuse: { code: 'target-required', reason: 'react:to' } },
    { skill: 'message.create', args: { reply: '#3', text: 'πρώτο' } },
    { skill: 'message.create', args: { text: 'δεύτερο' } },
  ]);
});

test("innerOutputCalls: a current channel other than the turn's is named by the place argument", () => {
  const calls = innerOutputCalls({ messages: [{ text: 'x', replyTo: null }] }, { current: 'c9', turnChannel: 'c1' });
  assert.deepEqual(
    calls.map((call) => call.args.place),
    ['c9']
  );
});

test('innerOutputCalls: with no current channel every post is refused destination-required; a reaction naming its message is not', () => {
  const calls = innerOutputCalls(parsed, { current: null, turnChannel: 'c1' });
  const codes = calls.map((call) => `${call.skill}:${call.refuse?.code ?? ''}`);
  assert.deepEqual(codes, [
    'message.react.add:',
    'message.react.add:target-required',
    'message.create:destination-required',
    'message.create:destination-required',
  ]);
});

test('innerOutputCalls: nothing written, nothing lowered', () => {
  assert.deepEqual(
    innerOutputCalls(
      // `draw` is not a field the function reads; the test checks that an extra field lowers to nothing.
      wrongly({ messages: [], reactions: [], draw: null }),
      { current: 'c1', turnChannel: 'c1' }
    ),
    []
  );
  assert.deepEqual(innerOutputCalls(wrongly(null), { current: 'c1', turnChannel: 'c1' }), []);
});
