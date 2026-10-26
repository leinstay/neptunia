// Tests for the inbound event kinds added in stage 2 PR 4 (src/protocol/events.js, validate.js):
// presence.changed, presence.snapshot, conversation.changed and connection.changed, and the optional
// fields added to voice.changed, Author and membership.changed.member. Everything is checked through
// the public validateEvent and EVENT_KINDS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_KINDS, EVENT_KINDS, validateEvent } from '../src/protocol/index.js';

type Json = Record<string, unknown>;

const conversation = { id: 'c1', kind: 'channel', communityId: 'g1', name: 'general', topic: null, category: null };

const activity = { kind: 'playing', name: 'Chess', details: 'Endgame', state: 'Winning' };

const presence = {
  userId: 'u1',
  name: 'Eleni',
  status: 'online',
  activities: [activity],
};

const voice = {
  communityId: 'g1',
  userId: 'u1',
  name: 'Eleni',
  conversationId: 'v1',
  previousId: null,
  muted: false,
  deafened: false,
  streaming: false,
  camera: false,
};

const presenceChanged: Json = {
  kind: 'presence.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:presence:u1:1000',
  ...presence,
};

const presenceSnapshot: Json = {
  kind: 'presence.snapshot',
  iface: 'discord',
  at: 1000,
  id: 'discord:presence-snapshot:g1:1000',
  voice: [voice],
  presence: [presence],
};

const conversationChanged: Json = {
  kind: 'conversation.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:conversation:c1:created:1000',
  conversation,
  change: 'created',
};

const connectionChanged: Json = {
  kind: 'connection.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:connection:lost:1000',
  state: 'lost',
};

const without = (event: Json, key: string): Json => {
  const copy = { ...event };
  delete copy[key];
  return copy;
};

const refusal = (reason: string) => ({ ok: false, reason });

test('lists the four new kinds after the existing eight, and sends none of them from the core', () => {
  assert.deepEqual([...EVENT_KINDS].slice(8), [
    'presence.changed',
    'presence.snapshot',
    'conversation.changed',
    'connection.changed',
  ]);
  assert.deepEqual([...CORE_KINDS], ['scheduler.tick', 'task.completed', 'inner.wake']);
});

test('accepts a presence.changed event in its documented shape', () => {
  assert.deepEqual(validateEvent(presenceChanged), { ok: true });
});

test('accepts a presence.changed event with a null name and no activities', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, name: null, activities: [] }), { ok: true });
});

test('accepts every presence status and every activity kind', () => {
  for (const status of ['online', 'idle', 'dnd', 'offline', 'unknown'])
    assert.deepEqual(validateEvent({ ...presenceChanged, status }), { ok: true }, status);
  for (const kind of ['playing', 'streaming', 'listening', 'watching', 'competing', 'other'])
    assert.deepEqual(validateEvent({ ...presenceChanged, activities: [{ ...activity, kind }] }), { ok: true }, kind);
});

test('refuses a presence.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'userId', 'name', 'status', 'activities'])
    assert.deepEqual(validateEvent(without(presenceChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a presence.changed event with an empty user id or a non-string name', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, userId: '' }), refusal('userId:type'));
  assert.deepEqual(validateEvent({ ...presenceChanged, name: 5 }), refusal('name:type'));
});

test('refuses a presence status outside the five known ones', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, status: 'invisible' }), refusal('status:unknown'));
});

test('refuses an activity of an unknown kind', () => {
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [{ ...activity, kind: 'custom' }] }),
    refusal('activities.0.kind:unknown')
  );
});

test('refuses an activity missing a field, with the index of the activity', () => {
  const second = without(activity, 'details');
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [activity, second] }),
    refusal('activities.1.details:required')
  );
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [{ ...activity, name: 7 }] }),
    refusal('activities.0.name:type')
  );
});

test('refuses activities that are not a list', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, activities: 'playing' }), refusal('activities:type'));
});

test('accepts a presence.snapshot event in its documented shape', () => {
  assert.deepEqual(validateEvent(presenceSnapshot), { ok: true });
});

test('accepts an empty presence.snapshot', () => {
  assert.deepEqual(validateEvent({ ...presenceSnapshot, voice: [], presence: [] }), { ok: true });
});

test('refuses a presence.snapshot event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'voice', 'presence'])
    assert.deepEqual(validateEvent(without(presenceSnapshot, key)), refusal(`${key}:required`), key);
});

test('refuses a presence.snapshot whose lists are not lists', () => {
  assert.deepEqual(validateEvent({ ...presenceSnapshot, voice: {} }), refusal('voice:type'));
  assert.deepEqual(validateEvent({ ...presenceSnapshot, presence: null }), refusal('presence:type'));
});

test('refuses a snapshot presence entry with an unknown status, with its index', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, presence: [presence, { ...presence, status: 'away' }] }),
    refusal('presence.1.status:unknown')
  );
});

test('refuses a snapshot presence entry with an unknown activity kind', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, presence: [{ ...presence, activities: [{ ...activity, kind: 'x' }] }] }),
    refusal('presence.0.activities.0.kind:unknown')
  );
});

test('refuses a snapshot voice entry missing its user, with its index', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, voice: [voice, without(voice, 'userId')] }),
    refusal('voice.1.userId:required')
  );
});

test('accepts a conversation.changed event for each change', () => {
  for (const change of ['created', 'updated', 'deleted'])
    assert.deepEqual(validateEvent({ ...conversationChanged, change }), { ok: true }, change);
});

test('refuses a conversation.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'conversation', 'change'])
    assert.deepEqual(validateEvent(without(conversationChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a conversation.changed event with an unknown change', () => {
  assert.deepEqual(validateEvent({ ...conversationChanged, change: 'archived' }), refusal('change:unknown'));
});

test('checks the conversation of a conversation.changed event like any other conversation', () => {
  assert.deepEqual(
    validateEvent({ ...conversationChanged, conversation: { ...conversation, kind: 'forum' } }),
    refusal('conversation.kind:unknown')
  );
});

test('accepts a connection.changed event for each state', () => {
  for (const state of ['lost', 'resumed'])
    assert.deepEqual(validateEvent({ ...connectionChanged, state }), { ok: true }, state);
});

test('refuses a connection.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'state'])
    assert.deepEqual(validateEvent(without(connectionChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a connection.changed event with an unknown state', () => {
  assert.deepEqual(validateEvent({ ...connectionChanged, state: 'closed' }), refusal('state:unknown'));
});

test('refuses a new kind with a non-finite time', () => {
  assert.deepEqual(validateEvent({ ...connectionChanged, at: Number.NaN }), refusal('at:type'));
});

// The optional fields added to existing kinds.

const voiceChanged: Json = {
  kind: 'voice.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:voice:g1:u1:1000',
  communityId: 'g1',
  userId: 'u1',
  conversationId: 'v1',
  previousId: null,
};

test('accepts voice.changed with and without a name and a camera flag', () => {
  assert.deepEqual(validateEvent(voiceChanged), { ok: true });
  assert.deepEqual(validateEvent({ ...voiceChanged, name: 'Eleni', camera: true }), { ok: true });
  assert.deepEqual(validateEvent({ ...voiceChanged, name: null }), { ok: true });
});

test('refuses a voice.changed name that is not a string and a camera that is not a boolean', () => {
  assert.deepEqual(validateEvent({ ...voiceChanged, name: 5 }), refusal('name:type'));
  assert.deepEqual(validateEvent({ ...voiceChanged, camera: 'on' }), refusal('camera:type'));
});

const author = { id: 'u1', name: 'Eleni', self: false, bot: false };

function messageWithAuthor(extra: Json): Json {
  return {
    kind: 'message.received',
    iface: 'discord',
    at: 1000,
    id: 'discord:message:m1',
    conversation,
    message: {
      id: 'm1',
      author: { ...author, ...extra },
      content: 'hello',
      at: 1000,
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

test('accepts an author avatar with a hash and a url, with nulls, and with none', () => {
  assert.deepEqual(validateEvent(messageWithAuthor({})), { ok: true });
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: 'a1b2', url: 'https://cdn.example/a1b2.png' } })),
    {
      ok: true,
    }
  );
  assert.deepEqual(validateEvent(messageWithAuthor({ avatar: { hash: null, url: null } })), { ok: true });
});

test('refuses a malformed author avatar, naming the field', () => {
  assert.deepEqual(validateEvent(messageWithAuthor({ avatar: 'a1b2' })), refusal('message.author.avatar:type'));
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: 5, url: null } })),
    refusal('message.author.avatar.hash:type')
  );
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: null } })),
    refusal('message.author.avatar.url:required')
  );
});

const membershipChanged: Json = {
  kind: 'membership.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:member:g1:u1:joined:1000',
  communityId: 'g1',
  userId: 'u1',
  change: 'joined',
  member: { id: 'u1', name: 'Eleni', bot: false },
};

test('accepts a membership member avatar with a hash and a url, with nulls, and with none', () => {
  assert.deepEqual(validateEvent(membershipChanged), { ok: true });
  const withAvatar = (avatar: unknown) => ({
    ...membershipChanged,
    member: { ...(membershipChanged.member as Json), avatar },
  });
  assert.deepEqual(validateEvent(withAvatar({ hash: 'a1b2', url: 'https://cdn.example/a1b2.png' })), { ok: true });
  assert.deepEqual(validateEvent(withAvatar({ hash: null, url: null })), { ok: true });
});

test('refuses a malformed membership member avatar, naming the field', () => {
  const withAvatar = (avatar: unknown) => ({
    ...membershipChanged,
    member: { ...(membershipChanged.member as Json), avatar },
  });
  assert.deepEqual(validateEvent(withAvatar(7)), refusal('member.avatar:type'));
  assert.deepEqual(validateEvent(withAvatar({ hash: null, url: 3 })), refusal('member.avatar.url:type'));
});

test('still validates every event of the replay fixture basic-chat.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('./fixtures/events/basic-chat.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(text) as { iface: string; events: Array<Json> };
  assert.ok(fixture.events.length > 0);
  for (const event of fixture.events) {
    const full = { iface: fixture.iface, ...event };
    assert.deepEqual(validateEvent(full), { ok: true }, String(event.id));
  }
});
