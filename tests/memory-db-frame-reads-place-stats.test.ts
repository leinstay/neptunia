// Tests for what src/memory/db/frame-reads.ts reads of a place for the current place of `<surroundings>` and the entries
// of `<places>` (spec 2026-11-12-what-the-frame-dropped, slice 4). Signatures:
//   placeStatsOf(db: Db, ctx: Context, placeId: string, now: number): PlaceStats | null
//   type PlaceStats = { topic: string | null; writers: Array<string>; activity: 'live' | 'slow' | 'dead' | null;
//     lastMessageAt: number | null }
// `topic` is the column `places.topic`; `writers` are native account ids from the place's tally, the most writing first, at
// most five; `activity` is what `channelActivity` (src/memory/channels.ts) gives the tally at `now`, null for a place with
// no tally; `lastMessageAt` is the tally's moment. The read is null for a place the context may not read or that does not
// exist, and a direct chat's stats read in that chat alone. The tally goes in through the write kind `channel-entry`.
// Synthetic SQLite rows over the mind-world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeStatsOf } from '../src/memory/db/frame-reads.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { addDm, addPerson, addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { storeTally } from './fixtures/memory-db/place-tally.ts';
import type { Tally } from './fixtures/memory-db/place-tally.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ZOE = 'person:fake:5678';
const NIKOS = 'person:fake:4242';
const GROUP = groupContext('fake');

/** The `fake` interface with one root, a room and two people with a direct chat each. */
function placeWorld(): { world: World; room: string; zoeDm: string; nikosDm: string } {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: 'garden' });
  addPerson(world.db, { id: ZOE, accounts: [{ id: 'fake:5678', iface: 'fake', native: '5678', names: ['Zoe'] }] });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Nikos'] }] });
  const zoeDm = addDm(world.db, { iface: 'fake', native: '5678', person: ZOE, account: 'fake:5678' });
  const nikosDm = addDm(world.db, { iface: 'fake', native: '4242', person: NIKOS, account: 'fake:4242' });
  return { world, room, zoeDm, nikosDm };
}

const tally = (over: Partial<Tally> = {}): Tally => ({ iface: 'fake', ...over });

test('a place with a topic and a tally gives the topic, the writers best first cut to five, and its last message', () => {
  // Bug: the read orders the writers by id or by the order of storage, keeps all seven, or reads the topic from the tally
  // (where the writer does not keep it) instead of the place's row.
  const { world, room } = placeWorld();
  try {
    const last = NOW - 5 * MIN;
    const writers = { w501: 3, w502: 9, w503: 1, w504: 7, w505: 5, w506: 2, w507: 8 };
    storeTally(
      world,
      room,
      tally({ topic: 'ΘΕΜΑ-ΚΗΠΟΥ', days: { '2026-11-02': 4 }, lastMessageAt: last, writers }),
      NOW
    );
    const stats = placeStatsOf(world.db, GROUP, room, NOW);
    assert.equal(stats?.topic, 'ΘΕΜΑ-ΚΗΠΟΥ');
    assert.deepEqual(stats?.writers, ['w502', 'w507', 'w504', 'w505', 'w501']);
    assert.equal(stats?.lastMessageAt, last);
  } finally {
    world.close();
  }
});

/** The activity the read gives for a tally with `days` and a last message `ago` milliseconds before `NOW`. */
function activityFor(days: Record<string, number>, ago: number): string | null | undefined {
  const { world, room } = placeWorld();
  try {
    storeTally(world, room, tally({ days, lastMessageAt: NOW - ago, writers: { w501: 1 } }), NOW);
    return placeStatsOf(world.db, GROUP, room, NOW)?.activity;
  } finally {
    world.close();
  }
}

test('a place with twenty messages over today and yesterday is live', () => {
  // Bug: the read leaves the activity null or counts the days in another zone, so a busy place never reads live.
  assert.equal(activityFor({ '2026-11-02': 12, '2026-11-01': 8 }, 5 * MIN), 'live');
});

test('a place with fewer messages whose last one is two days old is slow', () => {
  // Bug: the read calls every place with a tally live, or calls a quiet one dead.
  assert.equal(activityFor({ '2026-10-31': 3 }, 2 * DAY), 'slow');
});

test('a place whose last message is eight days old is dead', () => {
  // Bug: the read takes the clock of the machine instead of the `now` it is given, or never reaches dead.
  assert.equal(activityFor({ '2026-10-20': 3 }, 8 * DAY), 'dead');
});

test('the same tally reads live at one clock and dead at another', () => {
  // Bug: the activity is computed against the real clock, so a replay at a fixed moment gives another answer.
  const { world, room } = placeWorld();
  try {
    const days = { '2026-11-02': 25 };
    storeTally(world, room, tally({ days, lastMessageAt: NOW - MIN, writers: { w501: 1 } }), NOW);
    assert.equal(placeStatsOf(world.db, GROUP, room, NOW)?.activity, 'live');
    assert.equal(placeStatsOf(world.db, GROUP, room, NOW + 30 * DAY)?.activity, 'dead');
  } finally {
    world.close();
  }
});

test('a place with a topic and no tally gives a null activity, no writers and no last message', () => {
  // Bug: the read invents `dead` for a place nothing was counted in, or answers null and loses the topic of the row.
  const { world, room } = placeWorld();
  try {
    world.db.prepare('UPDATE places SET topic = ? WHERE id = ?').run('ΘΕΜΑ-ΧΩΡΙΣ-ΜΕΤΡΗΣΗ', room);
    assert.deepEqual(placeStatsOf(world.db, GROUP, room, NOW), {
      topic: 'ΘΕΜΑ-ΧΩΡΙΣ-ΜΕΤΡΗΣΗ',
      writers: [],
      activity: null,
      lastMessageAt: null,
    });
  } finally {
    world.close();
  }
});

test('a place that does not exist gives null', () => {
  // Bug: the read answers an empty stats object for an id no row holds, so a retired or mistyped place reads as quiet.
  const { world } = placeWorld();
  try {
    assert.equal(placeStatsOf(world.db, GROUP, 'fake:channel:missing', NOW), null);
  } finally {
    world.close();
  }
});

test('a direct chat reads its own stats in that chat', () => {
  // Bug: the read refuses every direct chat, or reads the tally of the room, so the chat never shows how active it is.
  const { world, zoeDm } = placeWorld();
  try {
    const last = NOW - 10 * MIN;
    storeTally(world, zoeDm, tally({ days: { '2026-11-02': 2 }, lastMessageAt: last, writers: { '5678': 2 } }), NOW);
    const stats = placeStatsOf(world.db, dmContext(ZOE, 'fake', zoeDm), zoeDm, NOW);
    assert.deepEqual(stats?.writers, ['5678']);
    assert.equal(stats?.lastMessageAt, last);
  } finally {
    world.close();
  }
});

test('the stats of a direct chat read null in a group turn', () => {
  // Bug: the read takes every place, so how active a private chat is, and who writes in it, shows in a room.
  const { world, zoeDm } = placeWorld();
  try {
    storeTally(
      world,
      zoeDm,
      tally({ days: { '2026-11-02': 2 }, lastMessageAt: NOW - MIN, writers: { '5678': 2 } }),
      NOW
    );
    assert.equal(placeStatsOf(world.db, GROUP, zoeDm, NOW), null);
  } finally {
    world.close();
  }
});

test('the stats of a direct chat read null in another direct chat', () => {
  // Bug: the read lets any direct chat in, so one person's chat shows the traffic of another person's.
  const { world, zoeDm, nikosDm } = placeWorld();
  try {
    storeTally(
      world,
      zoeDm,
      tally({ days: { '2026-11-02': 2 }, lastMessageAt: NOW - MIN, writers: { '5678': 2 } }),
      NOW
    );
    assert.equal(placeStatsOf(world.db, dmContext(NIKOS, 'fake', nikosDm), zoeDm, NOW), null);
  } finally {
    world.close();
  }
});

test('a direct chat reads the stats of a room as a group does', () => {
  // Bug: the read keeps a direct chat to its own place, so the room's activity never shows in a private talk.
  const { world, room, zoeDm } = placeWorld();
  try {
    storeTally(
      world,
      room,
      tally({ days: { '2026-11-02': 30 }, lastMessageAt: NOW - MIN, writers: { w501: 30 } }),
      NOW
    );
    assert.equal(placeStatsOf(world.db, dmContext(ZOE, 'fake', zoeDm), room, NOW)?.activity, 'live');
  } finally {
    world.close();
  }
});
