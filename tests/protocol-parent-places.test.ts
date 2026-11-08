// What an adapter declares about a place beyond its id: the authority it belongs to and the place that contains it, of
// any kind and at any depth. `kind` says what sort of chat it is and containment says where it sits: a channel in
// a category stays a channel. Discord's objects end inside its adapter (interfaces/discord/collect.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { chatOfChannel } from './fixtures/sdk-shaped.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { validateEvent } from '../src/protocol/index.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');

function eventIn(chat: Record<string, unknown>, id = 'm1'): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: 'other',
    at: NOW,
    id: `other:message:${id}`,
    chat,
    message: {
      id,
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: 'hello',
      at: NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

const placeOf = (chat: Record<string, unknown>) => observationOf(eventIn(chat))?.place;

test('the door refuses a parent kind or an authority that is not a name', () => {
  // Bug: a malformed declaration crosses the door and is stored as a place key.
  const room = { id: 'c1', kind: 'channel', rootId: 'g1' };
  assert.equal(validateEvent(eventIn(room)).ok, true);
  for (const bad of [{ parentKind: 7 }, { parentKind: '' }, { authorityId: 7 }, { authorityId: '' }])
    assert.equal(validateEvent(eventIn({ ...room, ...bad })).ok, false, JSON.stringify(bad));
  assert.equal(validateEvent(eventIn({ ...room, parentId: 'x', parentKind: 'category' })).ok, true);
});

test('a declared authority names the observed place, so one native id under two authorities is two places', () => {
  // Bug: the observation hard-codes `<iface>/global`, and two tenants of one interface share a place.
  const room = { id: 'c1', kind: 'channel', rootId: 'g1' };
  assert.equal(observationOf(eventIn({ ...room, authorityId: 'other/tenant-a' }))?.authority, 'other/tenant-a');
  assert.equal(observationOf(eventIn({ ...room, authorityId: 'other/tenant-a' }))?.place.authority, 'other/tenant-a');
  assert.equal(observationOf(eventIn(room))?.authority, 'other/global');
});

test('a channel declares the place that contains it and stays a channel', () => {
  // Bug: only a thread may have a parent, so a server, a category or a workspace above a channel is lost.
  const place = placeOf({ id: 'c1', kind: 'channel', chatType: 'channel', parentId: 'cat1', parentKind: 'category' });
  assert.equal(place?.kind, 'channel');
  assert.equal(place?.chat, 'group');
  assert.equal(place?.parent, 'category:cat1');
});

test('a thread may sit in any kind of place, and one with no declared kind sits in a channel', () => {
  // Bug: the parent key is hard-coded `channel:`, so a thread of a board points at a channel that does not exist.
  const thread = { id: 't1', kind: 'thread', chatType: 'thread', parentId: 'f1' };
  assert.equal(placeOf({ ...thread, parentKind: 'board' })?.parent, 'board:f1');
  assert.equal(placeOf({ ...thread, parentKind: 'board' })?.kind, 'thread');
  assert.equal(placeOf(thread)?.parent, 'channel:f1');
});

test('a group chat may declare a containing place and keeps its kind', () => {
  // Bug: containment is read from the chat kind, so a group inside a workspace is taken for a free-standing one.
  const place = placeOf({ id: 'g1', kind: 'dm', chatType: 'group_dm', parentId: 's1', parentKind: 'workspace' });
  assert.equal(place?.kind, 'group_dm');
  assert.equal(place?.parent, 'workspace:s1');
});

test('a chain of parents is stored place by place, whatever order they are seen in', () => {
  // A category is no place, the owner's word of 2026-11-06.
  // Bug: a parent no message was seen in has no row and an earlier child keeps no link, so the chain stops at the thread.
  const handle = openMemoryDb(':memory:');
  try {
    const quiet = { info() {}, warn() {}, error() {} };
    const stored = (chat: Record<string, unknown>, id: string): void => {
      const envelope = observationOf(eventIn(chat, id));
      const result = observe(handle, envelope, { now: () => NOW, log: quiet });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    stored({ id: 't1', kind: 'thread', chatType: 'thread', parentId: 'c1' }, 'm1');
    stored({ id: 'c1', kind: 'channel', chatType: 'channel', parentId: 'g1', parentKind: 'server' }, 'm2');
    const rows = dbOf(handle).prepare('SELECT id, native_key, parent_id FROM places').all() as Array<{
      id: string;
      native_key: string | null;
      parent_id: string | null;
    }>;
    const walked: Array<string | null> = [];
    let at = rows.find((row) => row.native_key === 'thread:t1');
    while (at !== undefined && walked.length < 6) {
      walked.push(at.native_key);
      const parent: string | null = at.parent_id;
      at = rows.find((row) => row.id === parent);
    }
    assert.deepEqual(walked, ['thread:t1', 'channel:c1', 'server:g1']);
  } finally {
    handle.close();
  }
});

test('a DM observed with no root stores no root place', () => {
  // Bug: a home root is made up for a DM, and it appears as a parent or a guild row in memory.
  const handle = openMemoryDb(':memory:');
  try {
    const envelope = observationOf(
      eventIn({ id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1', authorityId: 'other/x' })
    );
    assert.equal(envelope?.authority, 'other/x');
    assert.equal(envelope?.place.parent, undefined);
    observe(handle, envelope, { now: () => NOW, log: { info() {}, warn() {}, error() {} } });
    const parents = dbOf(handle).prepare("SELECT parent_id FROM places WHERE kind = 'dm'").all();
    assert.deepEqual(
      parents.map((row) => row.parent_id),
      [null]
    );
  } finally {
    handle.close();
  }
});

test('the Discord adapter declares the root as the parent of a channel in a category, and none for a DM', () => {
  // A category is no place, the owner's word of 2026-11-06.
  // Bug: a Discord object crosses the door, or a channel in a category reports the category as its parent.
  const inCategory = {
    id: 'c1',
    placeId: 'g1',
    guild: { id: 'g1' },
    type: ChannelType.GuildText,
    name: 'general',
    parentId: 'cat1',
    parent: { id: 'cat1', name: 'Rooms', type: ChannelType.GuildCategory },
    isThread: () => false,
  };
  const room = chatOfChannel(inCategory);
  assert.equal(room.kind, 'channel');
  assert.equal(room.parentId, 'g1');
  assert.deepEqual(room, JSON.parse(JSON.stringify(room)));
  assert.equal((room as { parentKind?: unknown }).parentKind, 'server');

  const direct = chatOfChannel({ id: 'd1', type: ChannelType.DM, recipientId: 'u1', isThread: () => false });
  assert.equal(direct.kind, 'dm');
  assert.equal(direct.rootId, null);
  assert.equal(direct.parentId, undefined);
});
