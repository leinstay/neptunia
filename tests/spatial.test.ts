// src/turn/request/spatial.ts: the `<spatial_awareness>` body, where and when she is, and the whereabouts a turn
// reads off its frame. The labels are the fixture's markers, so a test checks
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
//   export function whereaboutsOfFrame(frame: Frame, nouns?: Readonly<Record<string, string>>): Whereabouts;
// `chain` runs from the place itself up to the top of its tree. `notes` is `config.spatial.notes`: stored place id ->
// the owner's note.
// Stage AC, the owner's word of 2026-11-06: a wake with no conversation place says she is at the command line of her own
// server, a selfreflection post that she is in her own world; `nowhere` is gone, and these tests follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNow } from '../src/format.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import { spatialAwarenessText, whereaboutsOfFrame } from '../src/turn/request/spatial.ts';
import type { PlaceLink } from '../src/turn/request/spatial.ts';
import { frameInput, wakeInput } from './fixtures/frame-input.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-11-06T14:05:00Z');
const WHEN = formatNow(NOW, 'UTC', labels.locale);

const SERVER: PlaceLink = { id: 'p-server', kind: 'server', name: 'Example Server' };
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

// A category is no place, the owner's word of 2026-11-06, so no chain holds one. Slice 7: the labels hold no word for a
// server, a channel or a thread; each reads `spatial.kind` with its native kind as the noun (the fixture's
// `{noun} {name}`), so a channel no longer carries the `#` of the old `kinds.channel`.
test('a channel names the channel and its server, then the interface and the time', () => {
  // Bug: the path is read root first, or a level of the nesting is dropped, and she places herself in the server.
  assert.equal(
    textOf([CHANNEL, SERVER]),
    [`SPATIAL-PLACE channel general < server Example Server ON discord AT ${WHEN}`, 'SPATIAL-GROUP'].join('\n')
  );
});

test('a channel with no category goes straight to its server', () => {
  assert.equal(
    textOf([BARE_CHANNEL, SERVER]).split('\n')[0],
    `SPATIAL-PLACE channel off-topic < server Example Server ON discord AT ${WHEN}`
  );
});

test('a thread names itself, then the channel it sits in, up to the server', () => {
  // Bug: a thread is shown as its channel, so she answers the channel's topic inside a thread.
  assert.equal(
    textOf([THREAD, CHANNEL, SERVER]).split('\n')[0],
    `SPATIAL-PLACE thread weekend plans < channel general < server Example Server ON discord AT ${WHEN}`
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
  const lines = textOf([CHANNEL, SERVER], { 'p-server': 'adults only' }).split('\n');
  assert.equal(lines.at(-1), 'SPATIAL-NOTE adults only');
});

test("a channel's own note wins over the note of the places above it", () => {
  const notes = { 'p-server': 'adults only', 'p-channel': 'memes welcome' };
  const lines = textOf([CHANNEL, SERVER], notes).split('\n');
  assert.deepEqual(
    lines.filter((line) => line.startsWith('SPATIAL-NOTE')),
    ['SPATIAL-NOTE memes welcome']
  );
});

test('a blank note is no note, and the note of a place outside the chain is never shown', () => {
  // Bug: a cleared note leaves an empty line, or a sibling channel's note leaks into this one.
  const text = textOf([CHANNEL, SERVER], { 'p-channel': '   ', 'p-bare': 'not here' });
  assert.ok(!text.includes('SPATIAL-NOTE'), text);
});

test('no notes setting at all gives no note line and no failure', () => {
  // Bug: a deployment without `spatial.notes` throws in the middle of every turn.
  for (const notes of [undefined, null, 'adults only', ['adults only']]) {
    const text = textOf([CHANNEL, SERVER], notes);
    assert.ok(text.startsWith('SPATIAL-PLACE channel general'), text);
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

// Slice 7: a native kind the labels do not name reads `spatial.kind` with the kind itself as the noun
// (docs/prompt-contract.md), so only a place with no kind falls back to `kinds.place`.
test('a place with no kind and no name reads through the fallback labels, an unnamed kind through its own word', () => {
  // Bug: a place the store has not named yet renders `undefined` or a raw `{name}` to the model.
  const text = textOf([
    { id: 'p-x', kind: null, name: null },
    { id: 'p-y', kind: 'board', name: 'Notices' },
  ]);
  assert.equal(text.split('\n')[0], `SPATIAL-PLACE place UNNAMED < board Notices ON discord AT ${WHEN}`);
});

// Slice 7: whereaboutsOf left with the old producers; every turn states its whereabouts through its frame
// (whereaboutsOfFrame), and a place the tree does not hold yet is a chain of itself before the frame is built
// (src/turn/phases/request/build.ts).
test('whereaboutsOfFrame: the command line is the command line, whatever place it is given', () => {
  const frame = frameOf(
    frameInput({ interface: 'cli', chain: [DM], dm: { word: 'dm', nativeId: 'owner', partner: null } })
  );
  assert.deepEqual(whereaboutsOfFrame(frame), { kind: 'cli' });
});

test('whereaboutsOfFrame: a turn with no place or no interface is on her own server', () => {
  assert.deepEqual(whereaboutsOfFrame(frameOf(wakeInput('heartbeat', { interface: 'discord' }))), { kind: 'server' });
  assert.deepEqual(whereaboutsOfFrame(frameOf(frameInput({ interface: '', chain: [CHANNEL] }))), { kind: 'server' });
});

test('whereaboutsOfFrame: a place takes its chain from the frame and its privacy from the scope', () => {
  const group = frameOf(frameInput({ interface: 'discord', chain: [CHANNEL, SERVER] }));
  assert.deepEqual(whereaboutsOfFrame(group), {
    kind: 'place',
    iface: 'discord',
    private: false,
    chain: [CHANNEL, SERVER],
    nouns: {},
  });
  const direct = frameOf(
    frameInput({ interface: 'discord', chain: [DM], dm: { word: 'dm', nativeId: '1', partner: null } })
  );
  assert.deepEqual(whereaboutsOfFrame(direct), {
    kind: 'place',
    iface: 'discord',
    private: true,
    chain: [DM],
    nouns: {},
  });
});
