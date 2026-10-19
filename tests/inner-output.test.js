// Tests for src/behavior/inner-output.js: the output tags of an inner turn lowered into the
// calls a message.create / draw.create / message.react.add of hers would be, in the order an
// addressed turn acts in, and the ones that must be refused carry their code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerOutputCalls } from '../src/behavior/inner-output.js';

const parsed = {
  reactions: [{ to: 2, emoji: '👍' }],
  untargetedReactions: [{ emoji: '🔥' }],
  messages: [{ text: 'πρώτο', replyTo: 3 }, { text: 'δεύτερο', replyTo: null }],
  gif: { id: 'g7', replyTo: null },
  draw: { text: 'a boat', self: true, replyTo: 4 },
};

test('innerOutputCalls: reactions, messages, the GIF and the picture, in that order, each as the call it stands for', () => {
  const calls = innerOutputCalls(parsed, { current: 'c1', turnChannel: 'c1' });
  assert.deepEqual(calls, [
    { skill: 'message.react.add', args: { message: '#2', emoji: '👍' }, body: '' },
    { skill: 'message.react.add', args: { emoji: '🔥' }, body: '', refuse: { code: 'target-required', reason: 'react:to' } },
    { skill: 'message.create', args: { reply: '#3' }, body: 'πρώτο' },
    { skill: 'message.create', args: {}, body: 'δεύτερο' },
    { skill: 'message.create', args: { gif: 'g7' }, body: '' },
    { skill: 'draw.create', args: { self: 'true' }, body: 'a boat' },
  ]);
});

test('innerOutputCalls: a current channel other than the turn\'s is named by the channel argument', () => {
  const calls = innerOutputCalls({ messages: [{ text: 'x', replyTo: null }], draw: { text: 'y', self: false } }, { current: 'c9', turnChannel: 'c1' });
  assert.deepEqual(calls.map((call) => call.args.channel), ['c9', 'c9']);
});

test('innerOutputCalls: with no current channel every post is refused destination-required; a reaction naming its message is not', () => {
  const calls = innerOutputCalls(parsed, { current: null, turnChannel: 'c1' });
  const codes = calls.map((call) => `${call.skill}:${call.refuse?.code ?? ''}`);
  assert.deepEqual(codes, ['message.react.add:', 'message.react.add:target-required', 'message.create:destination-required', 'message.create:destination-required', 'message.create:destination-required', 'draw.create:destination-required']);
});

test('innerOutputCalls: nothing written, nothing lowered', () => {
  assert.deepEqual(innerOutputCalls({ messages: [], reactions: [], gif: null, draw: null }, { current: 'c1', turnChannel: 'c1' }), []);
  assert.deepEqual(innerOutputCalls(null, { current: 'c1', turnChannel: 'c1' }), []);
});
