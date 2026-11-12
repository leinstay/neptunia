// The current place in a request (spec 2026-11-12-what-the-frame-dropped, slice 4). `<place>` of `<surroundings>` holds, beside
// the purpose, the tone and the topics, the topic the interface gives the place (`surroundings.fields.topic`), who writes
// there most (`surroundings.fields.writers`, each writer as the `@handle` the rest of the request uses for that person) and
// how active it is (`surroundings.fields.activity` with the word `surroundings.activity.live`, `.slow` or `.dead`). Her own
// account is not a writer. A place with no topic, no writer and no tally has none of the three lines.
// Reply turns of the real turn runner over the service world (tests/fixtures/service-turn.ts#replyRun) at the fixed clock
// `TURN_NOW`, with the tally of the room `c1` stored through the write kind `channel-entry`. The facts are read off the
// request through the labels of config/labels.json, never their wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { storeTally } from './fixtures/memory-db/place-tally.ts';
import type { Tally } from './fixtures/memory-db/place-tally.ts';
import { useIface } from './fixtures/turn-world.ts';
import { ELENI, TURN_NOW, ZOE, blockOf, replyRun, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyStep } from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

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

/** The tally of the room: busy today, written by three accounts, her own the busiest. */
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
const lineOf = (place: string, label: string): string => place.split('\n').find((line) => line.startsWith(label)) ?? '';

test('<place> holds the topic of the room under the label of the topic', async () => {
  // Bug: the request builder hands <place> the stored descriptions alone, so the topic the interface gave never shows.
  const [place = ''] = await placesOf(withTally(BUSY));
  const line = lineOf(place, shipped('fields', 'topic'));
  assert.ok(line.includes('ΘΕΜΑ-ΛΕΣΧΗΣ'), place);
});

test('the writers of the room read as the handles the rest of the request uses, the busiest first', async () => {
  // Bug: the writers print as platform ids or display names, or in the order of the ids, so a person has one handle in
  // <people> and another here.
  const [place = ''] = await placesOf(withTally(BUSY));
  const line = lineOf(place, shipped('fields', 'writers'));
  const [first, second] = [handleIn(ELENI), handleIn(ZOE)].map((handle) => line.indexOf(handle));
  assert.ok(first !== undefined && second !== undefined && first >= 0 && second > first, line);
  assert.doesNotMatch(line, /<@|&lt;@|\b111\b|\b5678\b|person:/);
});

test('the handle of a writer is the handle of that person in <people>', async () => {
  // Bug: the writers are cut by a rule of their own, so the handle in <place> names nobody in <people>. Ελένη wrote in the
  // chat and has an entry there.
  const world = serviceWorld();
  try {
    withTally(BUSY)(world);
    const run = await replyRun({ world, steps: [turn('r2', 1)] });
    const [turnRequests = []] = run.requests;
    const request = turnRequests[0] ?? '';
    const people = /<people>\n?([\s\S]*?)\n?<\/people>/.exec(blockOf(request, 'memory'))?.[1] ?? '';
    const entry = people.split(/\n\s*\n/).find((one) => one.includes('Ελένη')) ?? '';
    const first = entry.split('\n')[0] ?? '';
    const heading = first.match(HANDLE)?.[0] ?? '';
    const place = /<place>\n?([\s\S]*?)\n?<\/place>/.exec(blockOf(request, 'surroundings'))?.[1] ?? '';
    assert.equal(heading, handleIn(ELENI));
    assert.ok(lineOf(place, shipped('fields', 'writers')).includes(heading), place);
  } finally {
    world.close();
  }
});

test('her own account is not among the writers of the room', async () => {
  // Bug: the busiest writer of the tally is her, and the line lists her next to the people, or as the unknown author an
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

test('a room with twenty messages over today and yesterday reads live in the word of the live label', async () => {
  // Bug: the code `live` is printed as it is, or the activity is read at another clock than the turn's.
  const line = await activityLine({ '2026-11-02': 12, '2026-11-01': 8 }, 5 * MIN);
  assert.ok(line.includes(shipped('activity', 'live')), line);
});

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

test('the three activity words differ from one another in the line', async () => {
  // Bug: the three states share one label, so the line says the same thing of a busy room and a dead one.
  const lines = await Promise.all([
    activityLine({ '2026-11-02': 25 }, MIN),
    activityLine({ '2026-10-31': 3 }, 2 * DAY),
    activityLine({ '2026-10-20': 3 }, 8 * DAY),
  ]);
  assert.equal(new Set(lines).size, 3, lines.join(' | '));
});

test('a room with no topic, no writer and no tally has none of the three lines', async () => {
  // Bug: the lines print with an empty value, or with `dead` for a room nothing was counted in.
  const [place = ''] = await placesOf(null);
  for (const key of ['topic', 'writers', 'activity']) {
    const label = shipped('fields', key);
    assert.equal(lineOf(place, label), '', `${key}: ${place}`);
  }
});

test('two requests with nothing stored between them hold the same bytes in <place>', async () => {
  // Bug: the writers come back in an order that moves between reads, or a line carries the clock, and the held
  // <surroundings> changes bytes between turns. Ελένη and Ζωή have the same count.
  const tied = withTally({ ...BUSY, writers: { '111': 6, '5678': 6 } });
  const [first = '', second = ''] = await placesOf(tied, [turn('r2', 3), turn('r3', 1)]);
  assert.ok(lineOf(first, shipped('fields', 'writers')).includes(handleIn(ZOE)), first);
  assert.equal(second, first);
});
