// Which places a read call may name or be told about (src/behavior/readable-places.ts#readablePlaces), and how the view
// of a call carries them (src/turn/calls.ts#callViewOf, `places`). The rule is the pull rail's (`checkPull`): a channel
// the persona can read whose audience the destination's viewers all share, and in a private chat or on the command line
// one its partner can view. A channel a reader may not see is never matched and never listed. Synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInfo } from '../src/protocol/adapter.ts';
import { readablePlaces } from '../src/behavior/readable-places.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { callViewOf } from '../src/turn/calls.ts';
import { channel, privateChannel } from './fixtures/reads-rig.ts';

const OWNER = 'u-owner';
const OTHER = 'u-other';
const CONFIG = { context: { pull: { sameAudience: true } } };

const general = channel('c1', { name: '💬 general' });
const herbs = channel('c2', { name: '🌿 herbs' });
const staff = privateChannel('c3', ['u-mod']);
const blind = channel('c4', { name: 'blind', permissions: { read: false, send: false, attach: false, react: false } });
const named = (info: ChatInfo, name: string): ChatInfo => ({ ...info, name });

/** A private chat of `partner`, the shape of the destination of a DM turn. */
function dmOf(partner: string): ChatInfo {
  return channel('d1', { kind: 'dm', rootId: null, chatType: 'dm', name: 'dm', partnerId: partner, audience: null });
}

/** The same listing seen by `viewer`: `viewers` says which channel the viewer can open. */
function listing(viewer: string): ReadonlyArray<ChatInfo> {
  return [
    { ...general, viewers: { [viewer]: true } },
    { ...herbs, viewers: { [viewer]: true } },
    { ...named(staff, 'staff room'), viewers: { [viewer]: false } },
    { ...blind, viewers: { [viewer]: true } },
    // Another person's private chat, which the persona has open and the viewer does not.
    {
      ...dmOf(OTHER),
      id: 'd2',
      name: 'dm with someone else',
      viewers: { [viewer]: false, [OTHER]: true },
    },
  ];
}

const namesOf = (places: ReadonlyArray<{ name: string }>): Array<string> => places.map((place) => place.name).sort();

test('in a group lists the channels the persona reads and everyone there can see, and no private one', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: general, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

test('in a group never lists the private channel, a channel she cannot read or a private chat', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const ids = readablePlaces({ snapshot, destination: general, config: CONFIG }).map((place) => place.id);
  for (const hidden of ['c3', 'c4', 'd2']) assert.equal(ids.includes(hidden), false, hidden);
});

test('carries the handle of the request for each place that has one', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({
    snapshot,
    destination: general,
    config: CONFIG,
    handles: new Map([['cg2', 'c2']]),
  });
  assert.equal(places.find((place) => place.id === 'c2')?.handle, 'cg2');
  assert.equal(places.find((place) => place.id === 'c1')?.handle, null);
});

test('in a private chat lists the channels its partner can view and nothing else', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

test('in a private chat never lists the private channel or the private chat of another person', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const ids = readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: OWNER, config: CONFIG }).map(
    (place) => place.id
  );
  assert.equal(ids.includes('c3'), false, 'the staff room, closed to this partner');
  assert.equal(ids.includes('d2'), false, "another person's private chat");
});

test('in a private chat judges by the partner: a channel closed to this partner stays hidden though the persona reads it', () => {
  const closedToOther = snapshotOf('g1', { chats: listing(OTHER), groups: [] });
  const places = readablePlaces({
    snapshot: closedToOther,
    destination: dmOf(OWNER),
    partnerId: OWNER,
    config: CONFIG,
  });
  assert.deepEqual(places, [], 'the listing has no view of the owner, so no channel is shown to him');
});

test('lists nothing in a private chat with no partner', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  assert.deepEqual(readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: null, config: CONFIG }), []);
});

test('lists nothing when there is no snapshot of the root', () => {
  assert.deepEqual(readablePlaces({ snapshot: null, destination: general, config: CONFIG }), []);
});

test('on the command line lists the channels the owner can view, never a closed one or a private chat', () => {
  const cli: ChatInfo = { ...dmOf(OWNER), id: 'cli:dm:owner', iface: 'cli', name: 'owner' };
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: cli, partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

// ---- the view of a call ---------------------------------------------------------------------------------------

test('the view of a call in a group carries the readable places and keeps the chats it had', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const view = callViewOf({ channel: general, snapshot, config: CONFIG });
  assert.deepEqual(namesOf(view.places ?? []), ['🌿 herbs', '💬 general']);
  assert.ok(
    view.chats?.some((entry) => entry.name === 'staff room'),
    'the posting path still sees every chat'
  );
});

test('the view of a call in a private chat carries the places its partner can view', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const view = callViewOf({ channel: dmOf(OWNER), snapshot, partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(view.places ?? []), ['🌿 herbs', '💬 general']);
});
