// The builders that turn discord.js objects into the events of the live glance (interfaces/discord/around.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAroundStore } from '../../../src/behavior/around-store.ts';
import { liveFields } from '../../../src/behavior/around.ts';
import { validateEvent } from '../../../src/protocol/index.ts';
import { presenceEvent, presenceSnapshotEvent, voiceEvent } from '../../../interfaces/discord/around.ts';
import { labels } from '../../fixtures/labels.ts';

// --- the builders over discord.js-shaped objects ---------------------------------

const GUILD = { id: 'g1' };

test('a voice state with selfMute builds an event with muted true and the member as accountId', () => {
  const event = voiceEvent(
    { id: 'u1', guild: GUILD, channelId: 'v1', selfMute: true, selfDeaf: false, member: { displayName: 'Ana' } },
    1000
  );
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(
    [event.kind, event.accountId, event.chatId, event.muted, event.deafened, event.name, event.at],
    ['voice.changed', 'u1', 'v1', true, false, 'Ana', 1000]
  );
});

test('a voice state in no channel builds an event with chatId null', () => {
  const event = voiceEvent({ id: 'u1', guild: GUILD, channelId: null }, 1000);
  assert.equal(validateEvent(event).ok, true);
  assert.equal(event.chatId, null);
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
        ['u2', { id: 'u2', guild: GUILD, placeId: null }],
      ]),
    },
    presences: {
      cache: new Map<string, object>([['u1', { userId: 'u1', guild: GUILD, status: 'dnd', activities: [] }]]),
    },
  };
  const event = presenceSnapshotEvent(guild, 9000);
  assert.equal(validateEvent(event).ok, true);
  assert.deepEqual(
    event.voice.map((entry: { accountId: string; camera?: boolean }) => [entry.accountId, entry.camera]),
    [['u1', true]]
  );
  assert.deepEqual(
    event.presence.map((entry: { accountId: string; status: string }) => [entry.accountId, entry.status]),
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
