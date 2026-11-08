import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { lineOf } from '../src/behavior/line-of.ts';

function eventWith(
  message: Partial<MessageEvent['message']> = {},
  addressing: Partial<MessageEvent['addressing']> = {}
): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: 5000,
    id: 'fake:message:m1',
    chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general', topic: 'chat' },
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: 'hello @Bob',
      at: 5000,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
      ...message,
    },
    addressing: {
      mentioned: false,
      replyToSelf: false,
      mentionedAccountIds: ['u2'],
      mentionedChatIds: [],
      ...addressing,
    },
  };
}

test('lineOf makes the line of a message event with the fields a turn reads, in their order', () => {
  // A category is no place, the owner's word of 2026-11-06.
  const line = lineOf(eventWith());
  assert.deepEqual(Object.keys(line).slice(0, 13), [
    'id',
    'placeId',
    'channelName',
    'channelTopic',
    'authorId',
    'authorName',
    'self',
    'bot',
    'content',
    'ts',
    'editedAt',
    'mentionedAccountIds',
    'mentionedUsers',
  ]);
  assert.deepEqual(
    [line.id, line.placeId, line.channelName, line.authorId, line.authorName, line.content, line.ts],
    ['m1', 'c1', 'general', 'u1', 'Alice', 'hello @Bob', 5000]
  );
  assert.deepEqual(line.mentionedAccountIds, ['u2']);
});

test('lineOf carries the reply, the forward and the edit stamp of the message', () => {
  const line = lineOf(
    eventWith({ replyToId: 'm0', replyPingAccountId: 'u3', forwardedFrom: 'elsewhere', editedAt: 6000 })
  );
  assert.deepEqual(
    [line.replyToId, line.replyPingAccountId, line.forwardedFrom, line.editedAt],
    ['m0', 'u3', 'elsewhere', 6000]
  );
});

test('lineOf marks the persona own line and a message never edited has a null stamp', () => {
  const line = lineOf(eventWith({ author: { id: 'self', name: 'Nova', self: true, bot: false } }));
  assert.equal(line.self, true);
  assert.equal(line.editedAt, null);
});
