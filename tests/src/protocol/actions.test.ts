// Tests for src/protocol/actions.ts, through src/protocol/index.ts: a port call as its action object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portAction, validateAction } from '../../../src/protocol/index.ts';

const ref = { iface: 'fake', chatId: 'c1' };
const messageRef = { iface: 'fake', chatId: 'c1', messageId: 'm1' };

test('portAction: a port call as its action object', () => {
  assert.deepEqual(portAction('send', [ref, { text: 'x' }]), {
    action: 'message.send',
    chat: ref,
    content: { text: 'x' },
  });
  assert.deepEqual(portAction('edit', [messageRef, { text: 'x' }]), {
    action: 'message.edit',
    message: messageRef,
    content: { text: 'x' },
  });
  assert.deepEqual(portAction('delete', [messageRef]), { action: 'message.delete', message: messageRef });
  assert.deepEqual(portAction('react', [messageRef, 'e']), {
    action: 'message.react.add',
    message: messageRef,
    emoji: 'e',
  });
  assert.deepEqual(portAction('unreact', [messageRef, 'e']), {
    action: 'message.react.remove',
    message: messageRef,
    emoji: 'e',
  });
  assert.deepEqual(portAction('typing', [ref]), { action: 'chat.typing', chat: ref });
  assert.equal(validateAction(portAction('shout', [ref])).ok, false);
  // @ts-expect-error null where the call arguments are a list, on purpose
  assert.equal(validateAction(portAction('send', null)).ok, false);
});

// The read of a DM partner's chat across the port: its wire shape and the fake's answer.

const PARTNER = { iface: 'discord', accountId: 'u1' };

test('the read crosses as dm.chat and is refused without its account', () => {
  const action = portAction('dmChatOf', [PARTNER]);
  assert.deepEqual(action, { action: 'dm.chat', iface: 'discord', accountId: 'u1' });
  assert.equal(validateAction(action).ok, true);
  assert.equal(validateAction({ action: 'dm.chat', iface: 'discord' }).ok, false);
  assert.equal(validateAction({ action: 'dm.chat', accountId: 'u1' }).ok, false);
});
