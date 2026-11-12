// Tests for src/memory/db/made-and-given.ts#madeAndGivenOf: what she made today at a person's asking, by skill, the
// lines that person addressed to her, and her day in two sums, read from the journal's `day` rows and the lines
// under the turn's context. Each test writes its calls through the journal a turn uses. Spec 2026-11-12
// made-and-given, slice 1. A person is a person id; the counts are keyed by skill name.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { madeAndGivenOf } from '../src/memory/db/made-and-given.ts';
import {
  ANNA,
  BORIS,
  CAFE,
  CAROL,
  DAY,
  DM,
  DORA,
  HOUR,
  KINDS,
  MIN,
  NATIVE,
  NOW,
  SALON,
  TZ,
  closeMadeWorlds,
  madeWorld,
} from './fixtures/made-and-given-world.ts';

after(closeMadeWorlds);

/** The reader's input for a turn that answers `answering`, with the shipped kinds and three other people at most. */
const input = (answering: string | null, people = 3) => ({ now: NOW, timezone: TZ, answering, kinds: KINDS, people });
const group = groupContext('discord');

test('counts each kind she made for the person she answers today, and the lines that person addressed to her', async () => {
  // Bug: the counts mix kinds, or the addressed count takes yesterday's line, another person's lines, or a line that is
  // both `direct` and a reply twice.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR, count: 3 });
  await w.calls(CAFE, { turn: 't1', skill: 'voice.say', at: NOW - 3 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 't2', at: NOW - 2 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 't2', skill: 'media.find', at: NOW - 2 * HOUR, count: 2 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.equal(got.answering?.person, ANNA);
  assert.deepEqual(got.answering?.today, { 'draw.create': 3, 'voice.say': 1, 'media.find': 2 });
  assert.equal(got.answering?.addressedToday, 6);
});

test('counts neither a failed call nor one that was only proposed, started or left unknown', async () => {
  // Bug: any line of a call counts as a thing made, so a refused picture and a call that never closed read as handed over.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  const at = NOW - 3 * HOUR;
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at, end: 'succeeded' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + MIN, end: 'failed' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 2 * MIN, end: 'proposed' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 3 * MIN, end: 'started' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 4 * MIN, end: 'unknown' });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
  assert.equal(got.forOthers, 1);
});

test('counts no call of a skill the kinds name no word for, and no post', async () => {
  // Bug: every skill call counts as a thing made, so her searches and posts read as pictures handed over.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  const at = NOW - 3 * HOUR;
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at });
  await w.call(CAFE, { turn: 't1', skill: 'media.find', at: at + MIN });
  await w.call(CAFE, { turn: 't1', skill: 'memory.search', at: at + 2 * MIN });
  await w.call(CAFE, { turn: 't1', skill: 'message.create', at: at + 3 * MIN, name: 'post' });
  const got = madeAndGivenOf(w.read(), group, { ...input(ANNA), kinds: ['draw.create', 'voice.say'] });
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
  assert.equal(got.forOthers, 1);
  assert.equal(got.own, 0);
});

test('counts a call of an inner turn as her own accord and puts it in no line of a person', async () => {
  // Bug: a call of a heartbeat turn is given to the last person she answered, or to nobody and dropped from her day.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'ta', at: NOW - 5 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 5 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 'th', at: NOW - 3 * HOUR, by: null });
  await w.calls(CAFE, { turn: 'th', skill: 'draw.create', at: NOW - 3 * HOUR, count: 2 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.equal(got.own, 2);
  assert.equal(got.forOthers, 1);
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
  assert.deepEqual(got.others, []);
});

test('counts a call whose turn left no start line, or no turn at all, as her own accord', async () => {
  // Bug: a call with no `turn.start` row to read the asker from throws, or inherits the asker of the call before it.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'ta', at: NOW - 5 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 5 * HOUR, count: 1 });
  await w.calls(CAFE, { turn: 'ghost', skill: 'draw.create', at: NOW - 4 * HOUR, count: 1 });
  await w.calls(CAFE, { turn: null, skill: 'draw.create', at: NOW - 3 * HOUR, count: 1 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.equal(got.own, 2);
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
});

test('counts a call of today for the person whose turn started before midnight', async () => {
  // Bug: the asker is looked for among today's rows only, so a turn that began at 23:58 hands her picture to nobody.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'tn', at: NOW - 12 * HOUR - 2 * MIN, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'tn', skill: 'draw.create', at: NOW - 12 * HOUR + 3 * MIN, count: 1 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
  assert.equal(got.own, 0);
});

test('puts the calls of the days before in the week of the person and not in today', async () => {
  // Bug: the window is not cut at the day's start, so yesterday's pictures read as today's, or the week reads nothing.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'told', at: NOW - 10 * DAY, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'told', skill: 'draw.create', at: NOW - 10 * DAY, count: 5 });
  await w.turn(CAFE, { id: 'ty', at: NOW - 1 * DAY, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ty', skill: 'draw.create', at: NOW - 1 * DAY, count: 2 });
  await w.calls(CAFE, { turn: 'ty', skill: 'voice.say', at: NOW - 1 * DAY + HOUR, count: 1 });
  await w.turn(CAFE, { id: 'tt', at: NOW - 2 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'tt', skill: 'draw.create', at: NOW - 2 * HOUR, count: 1 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(got.answering?.today, { 'draw.create': 1 });
  // The week holds today as well, and not the call of ten days ago.
  assert.deepEqual(got.answering?.week, { 'draw.create': 3, 'voice.say': 1 });
  assert.equal(got.forOthers, 1);
});

test('shows a thing made in a direct chat in that chat and not in a group turn', async () => {
  // Bug: the day is read without the turn's context, so a group learns what she made for a person in private.
  const w = madeWorld();
  await w.turn(DM, { id: 'tb', at: NOW - 3 * HOUR, by: NATIVE[BORIS] });
  await w.calls(DM, { turn: 'tb', skill: 'draw.create', at: NOW - 3 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 'ta', at: NOW - 2 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 2 * HOUR, count: 1 });
  const inGroup = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(inGroup.others, []);
  assert.equal(inGroup.forOthers, 1);
  const inDm = madeAndGivenOf(w.read(), dmContext(BORIS, 'discord', DM), input(BORIS));
  assert.deepEqual(inDm.answering?.today, { 'draw.create': 1 });
});

test('puts the person she answers first, then the most asking others, up to the setting', async () => {
  // Bug: the others come in the order of time, the answered person is among them, or a person beyond the setting still
  // takes a line, or is dropped from the day's sum.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'tc', at: NOW - 6 * HOUR, by: NATIVE[CAROL] });
  await w.calls(CAFE, { turn: 'tc', skill: 'draw.create', at: NOW - 6 * HOUR, count: 2 });
  await w.turn(SALON, { id: 'td', at: NOW - 5 * HOUR, by: NATIVE[DORA] });
  await w.calls(SALON, { turn: 'td', skill: 'draw.create', at: NOW - 5 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 'ta', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 4 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 'tb', at: NOW - 3 * HOUR, by: NATIVE[BORIS] });
  await w.calls(CAFE, { turn: 'tb', skill: 'voice.say', at: NOW - 3 * HOUR, count: 4 });
  const got = madeAndGivenOf(w.read(), group, input(ANNA, 2));
  assert.equal(got.answering?.person, ANNA);
  assert.deepEqual(
    got.others.map((one) => one.person),
    [BORIS, CAROL]
  );
  // Dora is left out of the lines and stays in the day's sum: 1 + 2 + 1 + 4.
  assert.equal(got.forOthers, 8);
});

test('reads nothing for a day with nothing made, though the person wrote to her', async () => {
  // Bug: the addressed count alone opens a line, so a day of reads and posts adds text to `<my_day>`.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'memory.search', at: NOW - 3 * HOUR });
  await w.call(CAFE, { turn: 't1', skill: 'message.create', at: NOW - 3 * HOUR + MIN, name: 'post' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 3 * HOUR + 2 * MIN, end: 'failed' });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(got, { answering: null, others: [], own: 0, forOthers: 0 });
});
