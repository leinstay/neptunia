// The chat directory of the core (src/interface/directory.ts) keeps the whole `Chat` record an interface
// reported: `get(id)` answers the record, `chats()` every record. The address of a direct chat is the place's in
// memory (tests/place-chat.test.ts), so the directory answers none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatDirectory } from '../src/interface/directory.ts';
import type { Chat, ChatChanged } from '../src/protocol/events.ts';

function changed(change: ChatChanged['change'], chat: Chat): ChatChanged {
  return {
    kind: 'chat.changed',
    iface: 'discord',
    at: 1,
    id: `discord:chat:${chat.id}:${change}`,
    chat,
    change,
  };
}

test('keeps the whole record a chat change carried', () => {
  const directory = createChatDirectory();
  const record: Chat = {
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'general',
    topic: 'daily talk',
    chatType: 'channel',
  };
  directory.apply(changed('created', record));
  assert.deepEqual(directory.get('c1'), record);
  assert.deepEqual(directory.chats(), [record]);
  assert.equal(directory.nameOf('c1'), 'general');
});

test('answers null for a record it never saw', () => {
  const directory = createChatDirectory();
  assert.equal(directory.get('nowhere'), null);
});
