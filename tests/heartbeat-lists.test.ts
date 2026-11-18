// The people and the places a heartbeat lists (src/memory/db/heartbeat-lists.ts), read on a memory database built with
// the real schema (tests/fixtures/memory-db/mind-world.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatListsOf } from '../src/memory/db/heartbeat-lists.ts';
import { ELENI, MIRROR, NIKOS, TURN_NOW, YARD, heartbeatWorld } from './fixtures/service-turn.ts';
import { addLine } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

test('reads every live chat, a group room and a direct chat, on the real schema of places', () => {
  // Bug: a scope clause names columns `places` does not have (`scope_iface`) and the read throws on a real database.
  const world = heartbeatWorld();
  try {
    const { people, places } = heartbeatListsOf(world.db, TURN_NOW);
    const ids = places.map((one) => one.placeId);
    assert.ok(ids.includes(YARD), ids.join(' '));
    assert.ok(ids.includes('fake:dm:5678'), ids.join(' '));
    assert.ok(!ids.includes(MIRROR), ids.join(' '));
    assert.ok(
      people.some((one) => one.personId === NIKOS),
      people.map((one) => one.personId).join(' ')
    );
  } finally {
    world.close();
  }
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROOM = 'fake:channel:c1';
const ELENI_DM = 'fake:dm:111';
const iso = (ago: number): string => new Date(TURN_NOW - ago).toISOString();

/** A line in `place`, hers when `author` is `self` (written by a turn of hers), with its reply and its mentions. */
function lineOf(world: World, { id, place, author, ago, replyTo = null, mentions = null }: LineSpec): void {
  addLine(world.db, {
    id,
    iface: 'fake',
    place,
    author,
    text: `T-${id}`,
    at: iso(ago),
    turn: author === 'self' ? `turn:${id}` : null,
  });
  world.db
    .prepare('UPDATE sources SET reply_to = ?, mentions = ? WHERE id = ?')
    .run(replyTo, mentions === null ? null : JSON.stringify(mentions), id);
}
type LineSpec = {
  id: string;
  place: string;
  author: string;
  ago: number;
  replyTo?: string | null;
  mentions?: Array<string> | null;
};

/** The lists of `world` at the turn's moment, the world closed after. */
function listsOf(world: World): ReturnType<typeof heartbeatListsOf> {
  try {
    return heartbeatListsOf(world.db, TURN_NOW);
  } finally {
    world.close();
  }
}

const personOf = (lists: ReturnType<typeof heartbeatListsOf>, id: string) =>
  lists.people.find((one) => one.personId === id);

test('a person she answered by a reply who answered her back reads as answered with the date', () => {
  // Bug: the approach reads nothing of what followed, or misses an answer that names her line by reply_to.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 10 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // Changed: the approach says whether their first line after hers answers it by reply and whether her line stands in
  // their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, {
    placeId: YARD,
    at: TURN_NOW - 20 * HOUR,
    direct: false,
    after: { at: TURN_NOW - 10 * HOUR, reply: true },
  });
});

test('a person who wrote nothing after her reply to them reads as no line recorded after it', () => {
  // Bug: a line of someone else after hers, or their own line before it, counts as their answer.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:111', ago: 10 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // Changed: the approach says whether their first line after hers answers it by reply and whether her line stands in
  // their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, { placeId: YARD, at: TURN_NOW - 20 * HOUR, direct: false, after: null });
});

test('a person she only mentioned, who answered by a reply in a room they never wrote in, is found', () => {
  // Bug: only a reply of hers counts as addressing someone, so a mention is never read.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 5 * HOUR, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: 4 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // Changed: the approach says whether their first line after hers answers it by reply and whether her line stands in
  // their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, {
    placeId: ROOM,
    at: TURN_NOW - 5 * HOUR,
    direct: false,
    after: { at: TURN_NOW - 4 * HOUR, reply: true },
  });
});

test('a person she never addressed has no approach', () => {
  // Bug: her newest line anywhere, or one in a room they wrote in, counts as addressed to them.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.equal(nikos?.approach, null);
});

test('a line of hers in their direct chat followed by a line of theirs reads as answered', () => {
  // Bug: a line in their direct chat is not read as addressed to them, or their later line there is not what followed.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ELENI_DM, author: 'self', ago: 6 * HOUR });
  lineOf(world, { id: 'a2', place: ELENI_DM, author: 'fake:111', ago: 2 * HOUR });
  const eleni = personOf(listsOf(world), ELENI);
  // Changed: the approach says whether their first line after hers answers it by reply and whether her line stands in
  // their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(eleni?.approach, {
    placeId: ELENI_DM,
    at: TURN_NOW - 6 * HOUR,
    direct: true,
    after: { at: TURN_NOW - 2 * HOUR, reply: false },
  });
});

test('a person who wrote in the same group place ten minutes later with no reply target wrote there after it', () => {
  // Bug: only a reply counts as what followed, so a person who answered in plain lines reads as silent.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 20 * HOUR - 10 * MINUTE });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.deepEqual(nikos?.approach?.after, { at: TURN_NOW - 20 * HOUR + 10 * MINUTE, reply: false });
});

test('a person whose only later line in the group place came two days after hers has none within a day', () => {
  // Bug: any later line of theirs in a busy room counts as what followed her line, however late.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 3 * DAY, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: DAY });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.equal(nikos?.approach?.after, null);
});

test('a person who answered her line by reply three days later answered it', () => {
  // Bug: the day's window cuts off a reply that names her line, which answers it whenever it came.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 4 * DAY, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: DAY, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.deepEqual(nikos?.approach?.after, { at: TURN_NOW - DAY, reply: true });
});

test('a group place counts the lines that answer her last line there', () => {
  // Bug: the place reads that she wrote and nothing of whether anyone answered it.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a0', place: YARD, author: 'self', ago: 30 * HOUR });
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 10 * HOUR, replyTo: 'a1' });
  lineOf(world, { id: 'a3', place: YARD, author: 'fake:111', ago: 9 * HOUR, replyTo: 'a0' });
  const yard = listsOf(world).places.find((one) => one.placeId === YARD);
  assert.equal(yard?.ownAnswers, 1);
});
