import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReadAction,
  messageExtrasProblem,
  readAction,
  readActionProblem,
  READ_ACTIONS,
} from '../src/protocol/reads.ts';

const REF = { iface: 'fake', conversationId: 'c1' };

test('readAction turns a method call into its wire action and gives null for a method that is no read', () => {
  assert.deepEqual(readAction('history', [REF, { limit: 5, before: 'm1', after: undefined }]), {
    action: 'messages.history',
    conversation: REF,
    limit: 5,
    before: 'm1',
  });
  assert.deepEqual(readAction('memberInfo', [{ communityId: 'g1', memberId: 'u1' }]), {
    action: 'member.info',
    communityId: 'g1',
    memberId: 'u1',
  });
  assert.deepEqual(readAction('reactors', [{ ...REF, messageId: 'm1' }, '🔥', 10]), {
    action: 'message.reactors',
    message: { ...REF, messageId: 'm1' },
    emoji: '🔥',
    limit: 10,
  });
  assert.equal(readAction('send', [REF, { text: 'x' }]), null);
});

test('isReadAction knows every read action of the port and no other name', () => {
  for (const name of READ_ACTIONS) assert.equal(isReadAction(name), true, name);
  assert.equal(isReadAction('message.send'), false);
  assert.equal(isReadAction(undefined), false);
});

test('readActionProblem names the first field of a history read that is wrong', () => {
  const good = { action: 'messages.history', conversation: REF, limit: 10 };
  assert.equal(readActionProblem(good), null);
  assert.deepEqual(readActionProblem({ ...good, limit: 0 }), ['limit', 'type']);
  assert.deepEqual(readActionProblem({ ...good, limit: 10_001 }), ['limit', 'type']);
  assert.deepEqual(readActionProblem({ ...good, before: 'a', after: 'b' }), ['history', 'anchors']);
  assert.deepEqual(readActionProblem({ ...good, since: 5, around: 'a' }), ['history', 'since']);
  assert.deepEqual(readActionProblem({ action: 'messages.history', limit: 10 }), ['conversation', 'required']);
});

test('readActionProblem refuses more than 25 viewers and a link parse of too many or too long texts', () => {
  const viewers = Array.from({ length: 26 }, (_, i) => `u${i}`);
  assert.deepEqual(readActionProblem({ action: 'conversation.info', conversation: REF, viewers }), [
    'viewers',
    'too-many',
  ]);
  assert.deepEqual(readActionProblem({ action: 'links.parse', texts: Array(51).fill('x') }), ['texts', 'too-many']);
  assert.deepEqual(readActionProblem({ action: 'links.parse', texts: ['x'.repeat(2001)] }), ['texts.0', 'too-long']);
  assert.equal(readActionProblem({ action: 'links.parse', texts: ['a', 'b'] }), null);
});

test('readActionProblem bounds the reactor and member limits and needs a whole message reference', () => {
  assert.deepEqual(
    readActionProblem({ action: 'message.reactors', message: { ...REF, messageId: 'm1' }, emoji: '🔥', limit: 101 }),
    ['limit', 'type']
  );
  assert.deepEqual(readActionProblem({ action: 'message.reactors', message: REF, emoji: '🔥', limit: 5 }), [
    'message.messageId',
    'required',
  ]);
  assert.deepEqual(readActionProblem({ action: 'members.search', communityId: 'g1', prefix: 'a', limit: 1001 }), [
    'limit',
    'type',
  ]);
});

test('readActionProblem gives null for an action that is no read', () => {
  assert.equal(readActionProblem({ action: 'message.send' }), null);
  assert.equal(readActionProblem(null), null);
});

test('messageExtrasProblem checks what a deletion still knows and the extras of a message', () => {
  const whole = () => true;
  assert.deepEqual(messageExtrasProblem({ deleted: true, message: { author: { name: 'x' } } }, whole), [
    'message.author.id',
    'required',
  ]);
  assert.equal(messageExtrasProblem({ deleted: true, message: { at: 5, author: { id: 'u1' } } }, whole), null);
  assert.deepEqual(messageExtrasProblem({ message: { system: 'yes' } }, whole), ['message.system', 'type']);
  assert.deepEqual(
    messageExtrasProblem({ message: {}, previous: { id: 'm0' } }, () => false),
    ['previous', 'type']
  );
  assert.equal(messageExtrasProblem({ partial: true, message: { system: 'yes' } }, whole), null);
});
