// Tests for the live glance in the core (src/behavior/around-store.ts), fed by protocol events through the door. The
// rows the store's view feeds are tested with the tests of src/behavior/around.ts and src/behavior/prompt.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAroundStore } from '../../../src/behavior/around-store.ts';

type Flags = { muted?: boolean; deafened?: boolean; streaming?: boolean; camera?: boolean };

const voice = (accountId: string, chatId: string | null, at: number, flags: Flags = {}) => ({
  kind: 'voice.changed' as const,
  iface: 'discord',
  at,
  id: `voice:${accountId}:${at}`,
  placeId: 'g1',
  accountId,
  name: null,
  chatId,
  previousId: null,
  ...flags,
});
const presence = (accountId: string, status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown', at = 1) => ({
  kind: 'presence.changed' as const,
  iface: 'discord',
  at,
  id: `presence:${accountId}:${at}`,
  accountId,
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
    accountId: 'u1',
    placeId: 'v1',
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
  assert.deepEqual([record?.placeId, record?.joinedAt], ['v2', 3000]);
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
      { placeId: 'g1', accountId: 'u2', chatId: 'v2', previousId: null },
      { placeId: 'g1', accountId: 'u3', chatId: 'v2', previousId: null, muted: true },
    ],
    presence: [{ accountId: 'u3', name: null, status: 'dnd', activities: [] }],
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
    presence: [{ accountId: 'u3', name: null, status: 'dnd', activities: [] }],
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
    voice: [{ placeId: 'g1', accountId: 'u2', chatId: 'v2', previousId: null }],
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
