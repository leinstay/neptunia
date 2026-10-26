// The conversation directory of the core (src/interface/directory.ts) keeps the whole `Conversation` record an interface
// reported and learns the direct chat of a member from the messages it sees: `observe(event)` takes a
// `message.received`, `dmConversationOf(partnerId)` answers the conversation id of the one-to-one chat with that member,
// `get(id)` the record, `conversations()` every record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationDirectory } from '../src/interface/directory.ts';
import type { Conversation, ConversationChanged, MessageReceived } from '../src/protocol/events.js';

function message(conversation: Conversation, id = 'm1'): MessageReceived {
  return {
    kind: 'message.received',
    iface: 'discord',
    at: 1,
    id: `discord:message:${id}`,
    conversation,
    message: {
      id,
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: 'hi',
      sourceText: 'hi',
      system: false,
      at: 1,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
}

function changed(change: ConversationChanged['change'], conversation: Conversation): ConversationChanged {
  return {
    kind: 'conversation.changed',
    iface: 'discord',
    at: 1,
    id: `discord:conversation:${conversation.id}:${change}`,
    conversation,
    change,
  };
}

const DM: Conversation = { id: 'd1', kind: 'dm', communityId: null, name: null, chatType: 'dm', partnerId: 'u1' };

test('learns the direct chat of a member from a message in it', () => {
  const directory = createConversationDirectory();
  directory.observe(message(DM));
  assert.equal(directory.dmConversationOf('u1'), 'd1');
});

test('answers null for a member whose direct chat it has not seen', () => {
  const directory = createConversationDirectory();
  directory.observe(message(DM));
  assert.equal(directory.dmConversationOf('u2'), null);
});

test('does not take a group chat for the direct chat of its first member', () => {
  const directory = createConversationDirectory();
  directory.observe(message({ ...DM, id: 'd2', chatType: 'group_dm', partnerId: null }));
  assert.equal(directory.dmConversationOf('u1'), null);
});

test('does not learn a direct chat from a message in a channel', () => {
  const directory = createConversationDirectory();
  directory.observe(message({ id: 'c1', kind: 'channel', communityId: 'g1', name: 'general' }));
  assert.equal(directory.dmConversationOf('u1'), null);
});

test('keeps the newest direct chat of a member when a second one is seen', () => {
  const directory = createConversationDirectory();
  directory.observe(message(DM));
  directory.observe(message({ ...DM, id: 'd7' }));
  assert.equal(directory.dmConversationOf('u1'), 'd7');
});

test('forgets a direct chat once its deletion is applied', () => {
  const directory = createConversationDirectory();
  directory.observe(message(DM));
  directory.apply(changed('deleted', DM));
  assert.equal(directory.dmConversationOf('u1'), null);
});

test('keeps the whole record a conversation change carried', () => {
  const directory = createConversationDirectory();
  const record: Conversation = {
    id: 'c1',
    kind: 'channel',
    communityId: 'g1',
    name: 'general',
    topic: 'daily talk',
    category: 'main',
    chatType: 'channel',
  };
  directory.apply(changed('created', record));
  assert.deepEqual(directory.get('c1'), record);
  assert.deepEqual(directory.conversations(), [record]);
  assert.equal(directory.nameOf('c1'), 'general');
});

test('answers null for a record it never saw', () => {
  const directory = createConversationDirectory();
  assert.equal(directory.get('nowhere'), null);
});
