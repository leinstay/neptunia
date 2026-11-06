// src/turn/request/spatial.ts: the `<spatial_awareness>` body, where and when she is, and the whereabouts a turn
// resolves from its interface, its place and the places tree. The labels are the fixture's markers, so a test checks
// which lines were built and in what order, never their wording. Synthetic names only.
//
// Signatures these tests hold the code to:
//   export type PlaceLink = { id: string; kind: string | null; name: string | null };
//   export type Whereabouts =
//     | { kind: 'cli' }
//     | { kind: 'server' }
//     | { kind: 'world' }
//     | { kind: 'place'; iface: string; private: boolean; chain: ReadonlyArray<PlaceLink> };
//   export function spatialAwarenessText(input: {
//     whereabouts: Whereabouts; now: number; timezone: string; labels: Labels; notes: unknown;
//   }): string;
//   export function whereaboutsOf(input: {
//     iface: string | null; placeId: string | null; isPrivate: boolean;
//     chainOf: ((placeId: string) => ReadonlyArray<PlaceLink>) | null;
//   }): Whereabouts;
// `chain` runs from the place itself up to the top of its tree. `notes` is `config.spatial.notes`: stored place id ->
// the owner's note.
// Stage AC, the owner's word of 2026-11-06: a wake with no conversation place says she is at the command line of her own
// server, a selfreflection post that she is in her own world; `nowhere` is gone, and these tests follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNow } from '../src/format.ts';
import { spatialAwarenessText, whereaboutsOf } from '../src/turn/request/spatial.ts';
import type { PlaceLink } from '../src/turn/request/spatial.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-11-06T14:05:00Z');
const WHEN = formatNow(NOW, 'UTC', labels.locale);

const SERVER: PlaceLink = { id: 'p-server', kind: 'server', name: 'Example Server' };
const CATEGORY: PlaceLink = { id: 'p-category', kind: 'category', name: 'Lounge' };
const CHANNEL: PlaceLink = { id: 'p-channel', kind: 'channel', name: 'general' };
const BARE_CHANNEL: PlaceLink = { id: 'p-bare', kind: 'channel', name: 'off-topic' };
const THREAD: PlaceLink = { id: 'p-thread', kind: 'thread', name: 'weekend plans' };
const DM: PlaceLink = { id: 'p-dm', kind: 'dm', name: 'Robin' };

function textOf(chain: ReadonlyArray<PlaceLink>, notes: unknown = {}, isPrivate = false): string {
  return spatialAwarenessText({
    whereabouts: { kind: 'place', iface: 'discord', private: isPrivate, chain },
    now: NOW,
    timezone: 'UTC',
    labels,
    notes,
  });
}

test('a channel in a category names the channel, its category and its server, then the interface and the time', () => {
  // Bug: the path is read root first, or a level of the nesting is dropped, and she places herself in the server.
  assert.equal(
    textOf([CHANNEL, CATEGORY, SERVER]),
    [
      `SPATIAL-PLACE channel #general < category Lounge < server Example Server ON discord AT ${WHEN}`,
      'SPATIAL-GROUP',
    ].join('\n')
  );
});

test('a channel with no category goes straight to its server', () => {
  assert.equal(
    textOf([BARE_CHANNEL, SERVER]).split('\n')[0],
    `SPATIAL-PLACE channel #off-topic < server Example Server ON discord AT ${WHEN}`
  );
});

test('a thread names itself, then the channel it sits in, up to the server', () => {
  // Bug: a thread is shown as its channel, so she answers the channel's topic inside a thread.
  assert.equal(
    textOf([THREAD, CHANNEL, CATEGORY, SERVER]).split('\n')[0],
    `SPATIAL-PLACE thread weekend plans < channel #general < category Lounge < server Example Server ON discord AT ${WHEN}`
  );
});

test('a direct chat is a private place, never a group one', () => {
  // Bug: a private chat reads as a group place and she talks to her partner as if others were listening.
  const lines = textOf([DM], {}, true).split('\n');
  assert.equal(lines[0], `SPATIAL-PLACE dm Robin ON discord AT ${WHEN}`);
  assert.ok(lines.includes('SPATIAL-PRIVATE'));
  assert.ok(!lines.includes('SPATIAL-GROUP'));
});

test('the command line says she is on the command line, with the time', () => {
  assert.equal(
    spatialAwarenessText({ whereabouts: { kind: 'cli' }, now: NOW, timezone: 'UTC', labels, notes: {} }),
    `SPATIAL-CLI AT ${WHEN}`
  );
});

test('a turn with no conversation place is on her own server, with the time', () => {
  // Bug: a heartbeat names the last channel she heard of as the place she is in.
  assert.equal(
    spatialAwarenessText({ whereabouts: { kind: 'server' }, now: NOW, timezone: 'UTC', labels, notes: {} }),
    `SPATIAL-SERVER AT ${WHEN}`
  );
});

test('a selfreflection post is in her own world, with the time', () => {
  // Bug: the diary names the channel it is published to, and the illusion of her world breaks.
  assert.equal(
    spatialAwarenessText({ whereabouts: { kind: 'world' }, now: NOW, timezone: 'UTC', labels, notes: {} }),
    `SPATIAL-WORLD AT ${WHEN}`
  );
});

test("a server's note reaches every channel under it", () => {
  // Bug: the owner writes his note once on the server and no channel shows it.
  const lines = textOf([CHANNEL, CATEGORY, SERVER], { 'p-server': 'adults only' }).split('\n');
  assert.equal(lines.at(-1), 'SPATIAL-NOTE adults only');
});

test("a channel's own note wins over the note of the places above it", () => {
  const notes = { 'p-server': 'adults only', 'p-category': 'calm talk', 'p-channel': 'memes welcome' };
  const lines = textOf([CHANNEL, CATEGORY, SERVER], notes).split('\n');
  assert.deepEqual(
    lines.filter((line) => line.startsWith('SPATIAL-NOTE')),
    ['SPATIAL-NOTE memes welcome']
  );
});

test('a category note reaches its channels when the channel has none', () => {
  const lines = textOf([CHANNEL, CATEGORY, SERVER], { 'p-server': 'adults only', 'p-category': 'calm talk' }).split(
    '\n'
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith('SPATIAL-NOTE')),
    ['SPATIAL-NOTE calm talk']
  );
});

test('a blank note is no note, and the note of a place outside the chain is never shown', () => {
  // Bug: a cleared note leaves an empty line, or a sibling channel's note leaks into this one.
  const text = textOf([CHANNEL, CATEGORY, SERVER], { 'p-channel': '   ', 'p-bare': 'not here' });
  assert.ok(!text.includes('SPATIAL-NOTE'), text);
});

test('no notes setting at all gives no note line and no failure', () => {
  // Bug: a deployment without `spatial.notes` throws in the middle of every turn.
  for (const notes of [undefined, null, 'adults only', ['adults only']]) {
    const text = textOf([CHANNEL, SERVER], notes);
    assert.ok(text.startsWith('SPATIAL-PLACE channel #general'), text);
    assert.ok(!text.includes('SPATIAL-NOTE'), text);
  }
});

test('the command line, her server and her world carry no note, whatever the notes hold', () => {
  const notes = { cli: 'x', server: 'y', world: 'z', 'p-server': 'adults only' };
  for (const whereabouts of [{ kind: 'cli' as const }, { kind: 'server' as const }, { kind: 'world' as const }]) {
    const text = spatialAwarenessText({ whereabouts, now: NOW, timezone: 'UTC', labels, notes });
    assert.ok(!text.includes('SPATIAL-NOTE'), text);
  }
});

test('a place of an unknown kind and with no name reads through the fallback labels', () => {
  // Bug: a place the store has not named yet renders `undefined` or a raw `{name}` to the model.
  const text = textOf([
    { id: 'p-x', kind: null, name: null },
    { id: 'p-y', kind: 'board', name: 'Notices' },
  ]);
  assert.equal(text.split('\n')[0], `SPATIAL-PLACE place UNNAMED < place Notices ON discord AT ${WHEN}`);
});

test('whereaboutsOf: the command line is the command line, whatever place it is given', () => {
  assert.deepEqual(whereaboutsOf({ iface: 'cli', placeId: 'cli:dm:owner', isPrivate: true, chainOf: () => [DM] }), {
    kind: 'cli',
  });
});

test('whereaboutsOf: a turn with no place or no interface is on her own server', () => {
  assert.deepEqual(whereaboutsOf({ iface: 'discord', placeId: null, isPrivate: false, chainOf: () => [CHANNEL] }), {
    kind: 'server',
  });
  assert.deepEqual(whereaboutsOf({ iface: null, placeId: 'p-channel', isPrivate: false, chainOf: () => [CHANNEL] }), {
    kind: 'server',
  });
});

test('whereaboutsOf: a place takes its chain from the tree and its privacy from the turn', () => {
  const asked: Array<string> = [];
  const chainOf = (placeId: string): ReadonlyArray<PlaceLink> => {
    asked.push(placeId);
    return [CHANNEL, CATEGORY, SERVER];
  };
  assert.deepEqual(whereaboutsOf({ iface: 'discord', placeId: 'p-channel', isPrivate: false, chainOf }), {
    kind: 'place',
    iface: 'discord',
    private: false,
    chain: [CHANNEL, CATEGORY, SERVER],
  });
  assert.deepEqual(asked, ['p-channel']);
});

test('whereaboutsOf: a place the tree does not know yet is still a place, unnamed', () => {
  // Bug: the first turn in a new channel says she is nowhere because no line of it is stored yet.
  const expected = {
    kind: 'place',
    iface: 'discord',
    private: true,
    chain: [{ id: 'p-new', kind: null, name: null }],
  };
  assert.deepEqual(whereaboutsOf({ iface: 'discord', placeId: 'p-new', isPrivate: true, chainOf: () => [] }), expected);
  assert.deepEqual(whereaboutsOf({ iface: 'discord', placeId: 'p-new', isPrivate: true, chainOf: null }), expected);
});
