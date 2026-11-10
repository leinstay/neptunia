// Tests for the chat directory of the core (src/interface/directory.ts): the names of the chats
// an interface reported through `chat.changed`, read by the inner life when it names a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatDirectory } from '../src/interface/directory.ts';
import type { ChatChanged, Chat } from '../src/protocol/events.ts';

function changed(change: ChatChanged['change'], id: string, name: string | null): ChatChanged {
  return {
    kind: 'chat.changed',
    iface: 'discord',
    at: 1,
    id: `discord:chat:${id}:${change}:${name}`,
    chat: { id, kind: 'channel', rootId: 'g1', name },
    change,
  };
}

test('names a chat after its creation is applied', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  assert.equal(directory.nameOf('c1'), 'general');
});

test('names a chat not seen before when the first event is an update', () => {
  const directory = createChatDirectory();
  directory.apply(changed('updated', 'c2', 'music'));
  assert.equal(directory.nameOf('c2'), 'music');
});

test('reads the new name once a rename is applied', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('updated', 'c1', 'lounge'));
  assert.equal(directory.nameOf('c1'), 'lounge');
});

test('forgets a chat once its deletion is applied', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('deleted', 'c1', 'general'));
  assert.equal(directory.nameOf('c1'), null);
  assert.deepEqual(directory.ids(), []);
});

test('answers null for an id it was never told about', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  assert.equal(directory.nameOf('c9'), null);
});

test('lists every chat it knows by id', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('created', 'c2', 'music'));
  directory.apply(changed('updated', 'c1', 'lounge'));
  assert.deepEqual([...directory.ids()].sort(), ['c1', 'c2']);
});

test('ignores the deletion of a chat it never knew', () => {
  const directory = createChatDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('deleted', 'c9', 'ghost'));
  assert.deepEqual(directory.ids(), ['c1']);
});

// The chat directory of the core (src/interface/directory.ts) keeps the whole `Chat` record an interface
// reported: `get(id)` answers the record, `chats()` every record. The address of a direct chat is the place's in
// memory (tests/place-chat.test.ts), so the directory answers none.

function directoryDmChanged(change: ChatChanged['change'], chat: Chat): ChatChanged {
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
  directory.apply(directoryDmChanged('created', record));
  assert.deepEqual(directory.get('c1'), record);
  assert.deepEqual(directory.chats(), [record]);
  assert.equal(directory.nameOf('c1'), 'general');
});

test('answers null for a record it never saw', () => {
  const directory = createChatDirectory();
  assert.equal(directory.get('nowhere'), null);
});
