// Tests for what src/memory/db/place-stats.ts reads of a place for the current place of `<surroundings>` and the entries
// of `<places>`. Signatures:
//   placeStatsOf(db: Db, ctx: Context, placeId: string, now: number): PlaceStats | null
//   type PlaceStats = { topic: string | null; writers: Array<string>; activity: 'live' | 'slow' | 'dead' | null;
//     lastMessageAt: number | null }
// `topic` is the column `places.topic`; `writers` are native account ids from the place's tally, the most writing first, at
// most five; `activity` is what `channelActivity` (src/memory/channels.ts) gives the tally at `now`, null for a place with
// no tally; `lastMessageAt` is the tally's moment. The read is null for a place the context may not read or that does not
// exist, and a direct chat's stats read in that chat alone. The tally goes in through the write kind `channel-entry`.
// Synthetic SQLite rows over the mind-world.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { placeStatsOf } from '../../../../src/memory/db/place-stats.ts';
import { dmContext, groupContext } from '../../../../src/memory/db/scope.ts';
import { addDm, addPerson, addRoom, noteInterface, openWorld, rootId } from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import { storeTally } from '../../../fixtures/memory-db/place-tally.ts';
import type { Tally } from '../../../fixtures/memory-db/place-tally.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { TURN_NOW, ZOE as STATS_ZOE, blockOf, replyRun, serviceWorld } from '../../../fixtures/service-turn.ts';
import type { ReplyStep } from '../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';

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

// The current place in a request (spec 2026-11-12-what-the-frame-dropped, slice 4). `<place>` of `<surroundings>` holds, beside
// the purpose, the tone and the topics, the topic the interface gives the place (`surroundings.fields.topic`), who writes
// there most (`surroundings.fields.writers`, each writer as the `@handle` the rest of the request uses for that person) and
// how active it is (`surroundings.fields.activity` with the word `surroundings.activity.live`, `.slow` or `.dead`). The persona's own
// account is not a writer. A place with no topic, no writer and no tally has none of the three lines.
// Reply turns of the real turn runner over the service world (tests/fixtures/service-turn.ts#replyRun) at the fixed clock
// `TURN_NOW`, with the tally of the room `c1` stored through the write kind `channel-entry`. The facts are read off the
// request through the labels of config/labels.json, never their wording.
describe('place stats in a reply turn', () => {
  useIface('fake');

  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const SAY = '<think>STEP 4. So: answer.</think><msg>εντάξει</msg>';
  const ROOM = 'fake:channel:c1';
  const HANDLE = /@u[0-9a-z]+/g;
  const handleIn = (person: string): string => `@${handleOf(person)}`;

  /** A label of `labels.surroundings` by its path, read at the moment of use so a missing one fails its own test. */
  function shipped(...keys: Array<string>): string {
    let node: unknown = shippedLabels.surroundings;
    for (const key of keys) node = typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
    if (typeof node !== 'string') throw new Error(`labels.surroundings.${keys.join('.')} is missing`);
    return node;
  }

  const turn = (id: string, ago: number): ReplyStep => ({
    trigger: { id, text: 'καλημέρα', at: TURN_NOW - ago * MIN },
    answers: [SAY],
  });

  /** The tally of the room: busy today, written by three accounts, the persona's own the busiest. */
  const BUSY: Tally = {
    iface: 'fake',
    topic: 'ΘΕΜΑ-ΛΕΣΧΗΣ',
    days: { '2026-11-02': 18, '2026-11-01': 9 },
    lastMessageAt: TURN_NOW - 5 * MIN,
    writers: { 'self-id': 20, '111': 9, '5678': 4 },
  };

  /** The `<place>` of each turn's request in the room `c1`, over a world where `store` ran, one text per turn. */
  async function placesOf(store: ((world: World) => void) | null, steps: ReadonlyArray<ReplyStep> = [turn('r2', 1)]) {
    const world = serviceWorld();
    try {
      store?.(world);
      const run = await replyRun({ world, steps });
      return run.requests.map((requests) => {
        const surroundings = blockOf(requests[0] ?? '', 'surroundings');
        return /<place>\n?([\s\S]*?)\n?<\/place>/.exec(surroundings)?.[1] ?? '';
      });
    } finally {
      world.close();
    }
  }

  const withTally = (tally: Tally) => (world: World) => storeTally(world, ROOM, tally, TURN_NOW);
  const lineOf = (place: string, label: string): string =>
    place.split('\n').find((line) => line.startsWith(label)) ?? '';

  test("the persona's own account is not among the writers of the room", async () => {
    // Bug: the busiest writer of the tally is the persona, and the line lists them next to the people, or as the unknown author an
    // account no row holds reads as.
    const [place = ''] = await placesOf(withTally(BUSY));
    const line = lineOf(place, shipped('fields', 'writers'));
    assert.equal(line.match(HANDLE)?.length, 2, line);
    assert.doesNotMatch(line, /self-id/);
    assert.ok(!line.includes(shippedLabels.authors?.unknown ?? 'someone'), line);
  });

  /** The line of the activity of a room whose tally has `days` and a last message `ago` milliseconds before the turn. */
  async function activityLine(days: Record<string, number>, ago: number): Promise<string> {
    const store = withTally({ ...BUSY, days, lastMessageAt: TURN_NOW - ago });
    const [place = ''] = await placesOf(store);
    return lineOf(place, shipped('fields', 'activity'));
  }

  test('a quieter room whose last message is two days old reads slow in the word of the slow label', async () => {
    // Bug: every room with a tally reads live, or the slow label is looked up under another key.
    const line = await activityLine({ '2026-10-31': 3 }, 2 * DAY);
    assert.ok(line.includes(shipped('activity', 'slow')), line);
  });

  test('a room whose last message is eight days old reads dead in the word of the dead label', async () => {
    // Bug: the age of the last message is not read, so a room nobody writes in reads as slow.
    const line = await activityLine({ '2026-10-20': 3 }, 8 * DAY);
    assert.ok(line.includes(shipped('activity', 'dead')), line);
  });

  test('two requests with nothing stored between them hold the same bytes in <place>', async () => {
    // Bug: the writers come back in an order that moves between reads, or a line carries the clock, and the held
    // <surroundings> changes bytes between turns. Ελένη and Ζωή have the same count.
    const tied = withTally({ ...BUSY, writers: { '111': 6, '5678': 6 } });
    const [first = '', second = ''] = await placesOf(tied, [turn('r2', 3), turn('r3', 1)]);
    assert.ok(lineOf(first, shipped('fields', 'writers')).includes(handleIn(STATS_ZOE)), first);
    assert.equal(second, first);
  });
});
