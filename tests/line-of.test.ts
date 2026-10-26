import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { lineOf } from '../src/behavior/line-of.js';

function eventWith(
  message: Partial<MessageEvent['message']> = {},
  addressing: Partial<MessageEvent['addressing']> = {}
): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: 5000,
    id: 'fake:message:m1',
    conversation: { id: 'c1', kind: 'channel', communityId: 'g1', name: 'general', topic: 'chat', category: 'Talk' },
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: 'hello @Bob',
      at: 5000,
      replyToId: null,
      replyPingUserId: null,
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
      mentionedUserIds: ['u2'],
      mentionedConversationIds: [],
      ...addressing,
    },
  };
}

test('lineOf makes the line of a message event with the fields a turn reads, in their order', () => {
  const line = lineOf(eventWith());
  assert.deepEqual(Object.keys(line).slice(0, 14), [
    'id',
    'channelId',
    'channelName',
    'channelCategory',
    'channelTopic',
    'authorId',
    'authorName',
    'self',
    'bot',
    'content',
    'ts',
    'editedAt',
    'mentionedUserIds',
    'mentionedUsers',
  ]);
  assert.deepEqual(
    [line.id, line.channelId, line.channelName, line.authorId, line.authorName, line.content, line.ts],
    ['m1', 'c1', 'general', 'u1', 'Alice', 'hello @Bob', 5000]
  );
  assert.deepEqual(line.mentionedUserIds, ['u2']);
});

test('lineOf carries the reply, the forward and the edit stamp of the message', () => {
  const line = lineOf(
    eventWith({ replyToId: 'm0', replyPingUserId: 'u3', forwardedFrom: 'elsewhere', editedAt: 6000 })
  );
  assert.deepEqual(
    [line.replyToId, line.replyPingUserId, line.forwardedFrom, line.editedAt],
    ['m0', 'u3', 'elsewhere', 6000]
  );
});

test('lineOf marks the persona own line and a message never edited has a null stamp', () => {
  const line = lineOf(eventWith({ author: { id: 'self', name: 'Nova', self: true, bot: false } }));
  assert.equal(line.self, true);
  assert.equal(line.editedAt, null);
});
