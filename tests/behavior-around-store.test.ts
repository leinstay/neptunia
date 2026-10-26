// Tests for the live glance in the core (src/behavior/around-store.ts), fed by protocol events through the door,
// and for the builders that turn discord.js objects into those events (interfaces/discord/around.js). The rows
// the store's view feeds are tested in tests/around.test.js and tests/prompt.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAroundStore } from '../src/behavior/around-store.ts';
import { liveFields } from '../src/behavior/around.js';
import { validateEvent } from '../src/protocol/index.js';
import { presenceEvent, presenceSnapshotEvent, voiceEvent } from '../interfaces/discord/around.js';
import { labels } from './fixtures/labels.js';

type Flags = { muted?: boolean; deafened?: boolean; streaming?: boolean; camera?: boolean };

const voice = (userId: string, conversationId: string | null, at: number, flags: Flags = {}) => ({
  kind: 'voice.changed' as const,
  iface: 'discord',
  at,
  id: `voice:${userId}:${at}`,
  guildId: 'g1',
  userId,
  name: null,
  conversationId,
  previousId: null,
  ...flags,
});
const presence = (userId: string, status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown', at = 1) => ({
  kind: 'presence.changed' as const,
  iface: 'discord',
  at,
  id: `presence:${userId}:${at}`,
  userId,
  name: null,
  status,
  activities: [],
});
const connection = (state: 'lost' | 'resumed', at = 1) => ({
  kind: 'connection.changed' as const,
  iface: 'discord',
  at,
  id: `connection:${state}:${at}`,
  state,
});

test('a join stamps joinedAt with the time of the event', () => {
  const store = createAroundStore({ presences: false });
  store.voiceChanged(voice('u1', 'v1', 1000));
  assert.deepEqual(store.view().voice.get('u1'), {
    memberId: 'u1',
    channelId: 'v1',
    name: null,
    muted: false,
    deafened: false,
    streaming: false,
    camera: false,
    joinedAt: 1000,
  });
});

test('a flag change in the same channel keeps joinedAt and replaces the flags', () => {
  const store = createAroundStore({ presences: false });
  store.voiceChanged(voice('u1', 'v1', 1000));
  store.voiceChanged(voice('u1', 'v1', 2000, { muted: true, streaming: true }));
  const record = store.view().voice.get('u1');
  assert.deepEqual([record?.joinedAt, record?.muted, record?.streaming, record?.deafened], [1000, true, true, false]);
});

test('a move to another channel restamps joinedAt', () => {
  const store = createAroundStore({ presences: false });
  store.voiceChanged(voice('u1', 'v1', 1000));
  store.voiceChanged(voice('u1', 'v2', 3000));
  const record = store.view().voice.get('u1');
  assert.deepEqual([record?.channelId, record?.joinedAt], ['v2', 3000]);
});

test('a leave removes the member and a later join stamps again', () => {
  const store = createAroundStore({ presences: false });
  store.voiceChanged(voice('u1', 'v1', 1000));
  store.voiceChanged(voice('u2', 'v1', 1500));
  store.voiceChanged(voice('u1', null, 2000));
  assert.deepEqual([...store.view().voice.keys()], ['u2']);
  store.voiceChanged(voice('u1', 'v1', 4000));
  assert.equal(store.view().voice.get('u1')?.joinedAt, 4000);
});

test('a presence event changes nothing while presences is false', () => {
  const store = createAroundStore({ presences: false });
  store.presenceChanged(presence('u1', 'online'));
  assert.equal(store.view().presence.size, 0);
  assert.equal(store.view().presences, false);
});

test('a presence event while presences is true replaces the record of the member', () => {
  const store = createAroundStore({ presences: true });
  store.presenceChanged(presence('u1', 'online', 1));
  store.presenceChanged(presence('u1', 'idle', 2));
  assert.equal(store.view().presence.size, 1);
  assert.equal(store.view().presence.get('u1')?.status, 'idle');
});

test('a snapshot replaces both maps and its voice records carry no joinedAt', () => {
  const store = createAroundStore({ presences: true });
  store.voiceChanged(voice('u1', 'v1', 1000));
  store.presenceChanged(presence('u1', 'online'));
  store.snapshot({
    kind: 'presence.snapshot',
    iface: 'discord',
    at: 5000,
    id: 'presence.snapshot:5000',
    voice: [
      { guildId: 'g1', userId: 'u2', conversationId: 'v2', previousId: null },
      { guildId: 'g1', userId: 'u3', conversationId: 'v2', previousId: null, muted: true },
    ],
    presence: [{ userId: 'u3', name: null, status: 'dnd', activities: [] }],
  });
  const view = store.view();
  assert.deepEqual([...view.voice.keys()], ['u2', 'u3']);
  assert.deepEqual([...view.presence.keys()], ['u3']);
  assert.equal('joinedAt' in (view.voice.get('u2') ?? {}), false);
  assert.equal(view.voice.get('u3')?.muted, true);
});

test('a snapshot leaves the presences empty while presences is false', () => {
  const store = createAroundStore({ presences: false });
  store.snapshot({
    kind: 'presence.snapshot',
    iface: 'discord',
    at: 5000,
    id: 'presence.snapshot:5000',
    voice: [],
    presence: [{ userId: 'u3', name: null, status: 'dnd', activities: [] }],
  });
  assert.equal(store.view().presence.size, 0);
});

test('a flag change after a snapshot does not invent a joinedAt, a move does', () => {
  const store = createAroundStore({ presences: false });
  store.snapshot({
    kind: 'presence.snapshot',
    iface: 'discord',
    at: 5000,
    id: 'presence.snapshot:5000',
    voice: [{ guildId: 'g1', userId: 'u2', conversationId: 'v2', previousId: null }],
    presence: [],
  });
  store.voiceChanged(voice('u2', 'v2', 6000, { deafened: true }));
  assert.equal('joinedAt' in (store.view().voice.get('u2') ?? {}), false);
  store.voiceChanged(voice('u2', 'v3', 7000));
  assert.equal(store.view().voice.get('u2')?.joinedAt, 7000);
});

test('lost marks the glance stale and resumed marks it fresh again', () => {
  const store = createAroundStore({ presences: true });
  assert.equal(store.view().stale, false);
  store.connection(connection('lost', 1));
  assert.deepEqual([store.view().stale, store.counts().stale], [true, true]);
  store.connection(connection('resumed', 2));
  assert.deepEqual([store.view().stale, store.counts().stale], [false, false]);
});

test('counts reports the sizes of both maps and nothing else', () => {
  const store = createAroundStore({ presences: true });
  store.voiceChanged(voice('u1', 'v1', 1));
  store.voiceChanged(voice('u2', 'v1', 1));
  store.presenceChanged(presence('u1', 'online'));
  assert.deepEqual(store.counts(), { voice: 2, presence: 1, stale: false });
});

test('the view is a copy a renderer cannot use to change the store', () => {
  const store = createAroundStore({ presences: true });
  store.voiceChanged(voice('u1', 'v1', 1));
  store.presenceChanged(presence('u1', 'online'));
  const view = store.view();
  view.voice.clear();
  view.presence.clear();
  assert.deepEqual(store.counts(), { voice: 1, presence: 1, stale: false });
});

// --- the builders over discord.js-shaped objects ---------------------------------

const GUILD = { id: 'g1' };

test('a voice state with selfMute builds an event with muted true and the member as userId', () => {
  const event = voiceEvent(
    { id: 'u1', guild: GUILD, channelId: 'v1', selfMute: true, selfDeaf: false, member: { displayName: 'Ana' } },
    1000
  );
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(
    [event.kind, event.userId, event.conversationId, event.muted, event.deafened, event.name, event.at],
    ['voice.changed', 'u1', 'v1', true, false, 'Ana', 1000]
  );
});

test('a voice state in no channel builds an event with conversationId null', () => {
  const event = voiceEvent({ id: 'u1', guild: GUILD, channelId: null }, 1000);
  assert.equal(validateEvent(event).ok, true);
  assert.equal(event.conversationId, null);
});

test('the id of a voice event comes from the member and the time, so a repeat is a duplicate', () => {
  const state = { id: 'u1', guild: GUILD, channelId: 'v1' };
  assert.equal(voiceEvent(state, 1000).id, voiceEvent(state, 1000).id);
  assert.notEqual(voiceEvent(state, 1000).id, voiceEvent(state, 2000).id);
  assert.notEqual(voiceEvent(state, 1000).id, voiceEvent({ ...state, id: 'u2' }, 1000).id);
});

test('a presence builds an event that drops a custom status and keeps the rest', () => {
  const event = presenceEvent(
    {
      userId: 'u1',
      guild: GUILD,
      status: 'online',
      activities: [
        { type: 0, name: 'Chess', details: 'blitz', state: 'round 2' },
        { type: 4, name: 'Custom Status', state: 'back soon' },
      ],
    },
    1000
  );
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(event.activities, [{ kind: 'playing', name: 'Chess', details: 'blitz', state: 'round 2' }]);
  assert.equal(JSON.stringify(event).includes('back soon'), false);
});

test('a Listening activity builds the kind listening, with empty details and state when it has none', () => {
  const event = presenceEvent(
    { userId: 'u1', guild: GUILD, status: 'idle', activities: [{ type: 2, name: 'Spotify' }] },
    1000
  );
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(event.activities, [{ kind: 'listening', name: 'Spotify', details: '', state: '' }]);
});

test('a status Discord does not define builds the status unknown', () => {
  const event = presenceEvent({ userId: 'u1', guild: GUILD, status: 'invisible', activities: [] }, 1000);
  assert.equal(validateEvent(event).ok, true);
  assert.equal(event.status, 'unknown');
});

test('a guild builds one snapshot event with its voice states and presences and without members in no channel', () => {
  const guild = {
    id: 'g1',
    voiceStates: {
      cache: new Map<string, object>([
        ['u1', { id: 'u1', guild: GUILD, channelId: 'v1', selfVideo: true }],
        ['u2', { id: 'u2', guild: GUILD, channelId: null }],
      ]),
    },
    presences: {
      cache: new Map<string, object>([['u1', { userId: 'u1', guild: GUILD, status: 'dnd', activities: [] }]]),
    },
  };
  const event = presenceSnapshotEvent(guild, 9000);
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(
    event.voice.map((entry: { userId: string; camera?: boolean }) => [entry.userId, entry.camera]),
    [['u1', true]]
  );
  assert.deepEqual(
    event.presence.map((entry: { userId: string; status: string }) => [entry.userId, entry.status]),
    [['u1', 'dnd']]
  );
});

test('every built event survives structuredClone unchanged', () => {
  const events = [
    voiceEvent({ id: 'u1', guild: GUILD, channelId: 'v1', selfMute: true }, 1),
    presenceEvent({ userId: 'u1', guild: GUILD, status: 'online', activities: [{ type: 2, name: 'Spotify' }] }, 2),
    presenceSnapshotEvent({ id: 'g1', voiceStates: { cache: new Map() }, presences: { cache: new Map() } }, 3),
  ];
  for (const event of events) assert.deepEqual(structuredClone(event), event);
});

test('a built listening event renders as listening in the rows once the store has it', () => {
  const store = createAroundStore({ presences: true });
  store.presenceChanged(
    presenceEvent(
      {
        userId: 'u1',
        guild: GUILD,
        status: 'online',
        activities: [{ type: 2, name: 'Spotify', details: 'Fado', state: 'Lisboa' }],
      },
      1
    )
  );
  const lines = liveFields(store.view(), 'u1', { labels, channelNameOf: () => null });
  assert.equal(
    lines.some((line: string) => line.includes('listening to Spotify')),
    true
  );
});
