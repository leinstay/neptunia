import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageLocator } from '../src/memory/db/message-locator.ts';

test('messageLocator refuses an unsupported version instead of accepting its routing fields', () => {
  const result = messageLocator(
    { v: 2, origin: 'protocol-message', iface: 'other', conversationId: 'room-42', messageId: 'message-73' },
    'other'
  );
  assert.equal(result, null);
});

test('messageLocator keeps its verified route when the caller later changes the input', () => {
  const input = {
    v: 1,
    origin: 'protocol-message',
    iface: 'other',
    conversationId: 'room-42',
    messageId: 'message-73',
    extra: 'untrusted',
  };
  const result = messageLocator(input, 'other');
  assert.deepEqual(input, {
    v: 1,
    origin: 'protocol-message',
    iface: 'other',
    conversationId: 'room-42',
    messageId: 'message-73',
    extra: 'untrusted',
  });
  input.conversationId = 'redirected-room';
  input.messageId = 'redirected-message';
  assert.deepEqual(result, {
    v: 1,
    origin: 'protocol-message',
    iface: 'other',
    conversationId: 'room-42',
    messageId: 'message-73',
  });
});
