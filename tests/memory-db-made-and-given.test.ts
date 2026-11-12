// Tests for src/memory/db/made-and-given.ts#madeAndGivenOf: what she made today at a person's asking, by skill, the
// lines that person addressed to her, and her day in two sums, read from the journal's `day` rows and the lines
// under the turn's context. Each test writes its calls through the journal a turn uses. Spec 2026-11-12
// made-and-given, slice 1. A person is a person id; the counts are keyed by skill name.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { madeAndGivenOf, madeInSpanOf } from '../src/memory/db/made-and-given.ts';
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

test('counts each kind she made for the person she answers today, and the turns that person started', async () => {
  // Bug: the counts mix kinds, or the addressed count takes the person's mentions and replies (`sources.direct`, a
  // reply to her line), which cover only an explicit address while most lines of a talk reach her by the door's own
  // judgement. The count is the turns of hers today that a line of the person started, each turn once, whatever
  // lines the person wrote. The fixture's lines of Anna (five of today with a mention or a reply, none started a
  // turn) must not count.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR + MIN, by: NATIVE[ANNA], attempt: 2 });
  await w.calls(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR, count: 3 });
  await w.calls(CAFE, { turn: 't1', skill: 'voice.say', at: NOW - 3 * HOUR, count: 1 });
  await w.turn(CAFE, { id: 't2', at: NOW - 2 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 't2', skill: 'media.find', at: NOW - 2 * HOUR, count: 2 });
  await w.turn(CAFE, { id: 't3', at: NOW - HOUR, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 'tb', at: NOW - HOUR, by: NATIVE[BORIS] });
  await w.turn(CAFE, { id: 'told', at: NOW - 30 * HOUR, by: NATIVE[ANNA] });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.equal(got.answering?.person, ANNA);
  assert.deepEqual(got.answering?.today, { 'draw.create': 3, 'voice.say': 1, 'media.find': 2 });
  assert.equal(got.answering?.addressedToday, 3);
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

test('reads nothing for a day with nothing made, though the person started turns', async () => {
  // Bug: the count of turns the person started alone opens a line, so a day of reads and posts adds text to `<my_day>`.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'memory.search', at: NOW - 3 * HOUR });
  await w.call(CAFE, { turn: 't1', skill: 'message.create', at: NOW - 3 * HOUR + MIN, name: 'post' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 3 * HOUR + 2 * MIN, end: 'failed' });
  const got = madeAndGivenOf(w.read(), group, input(ANNA));
  assert.deepEqual(got, { answering: null, others: [], own: 0, forOthers: 0 });
});

// Slice 2: the same facts for a span of time, as the memory session reads them (`madeInSpanOf`). The span is the
// batch's first to last line; a person is a person id and the counts are keyed by skill name.

/** The reader's input: the span, the people asked about, and the shipped kinds. */
const span = (from: number, to: number, people: ReadonlyArray<string>, kinds: ReadonlyArray<string> = KINDS) => ({
  from,
  to,
  people,
  kinds,
});
const FROM = NOW - 5 * HOUR;
const TO = NOW - 2 * HOUR;

test('counts each kind made for a person and the turns their lines started, inside the span', async () => {
  // Bug: the kinds are summed into one number, or the started count takes the person's lines or the attempts of a
  // turn (each turn counts once) instead of the turns a line of theirs started.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR + MIN, by: NATIVE[ANNA], attempt: 2 });
  await w.calls(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR, count: 3 });
  await w.calls(CAFE, { turn: 't1', skill: 'voice.say', at: NOW - 3 * HOUR - 30 * MIN, count: 1 });
  await w.turn(CAFE, { id: 't2', at: NOW - 3 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 't2', skill: 'media.find', at: NOW - 3 * HOUR, count: 2 });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA]));
  assert.deepEqual(got, [{ person: ANNA, made: { 'draw.create': 3, 'voice.say': 1, 'media.find': 2 }, started: 2 }]);
});

test('counts a call at the edge of the span and not one a minute outside it, though its turn began before', async () => {
  // Bug: the span is half open or off by a row, so the call at `from` or at `to` is lost, or one just outside is kept.
  // The turn began before `from`: the asker is found by the turn's start line wherever it is, and that start is no
  // part of the span's started count.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 6 * HOUR, by: NATIVE[ANNA] });
  const each = (skill: string, at: number) => w.call(CAFE, { turn: 't1', skill, at });
  await each('errand.run', FROM - MIN);
  await each('draw.create', FROM);
  await each('voice.say', TO);
  await each('media.find', TO + MIN);
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA]));
  assert.deepEqual(got, [{ person: ANNA, made: { 'draw.create': 1, 'voice.say': 1 }, started: 0 }]);
});

test('counts a turn started at the edge of the span and not one a minute outside it', async () => {
  // Bug: the turn starts are cut with a strict comparison, or not cut at all, so the started count follows the day or
  // the batch's neighbours.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'tbefore', at: FROM - MIN, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 'tfrom', at: FROM, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 'tto', at: TO, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 'tafter', at: TO + MIN, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'tfrom', skill: 'draw.create', at: FROM + MIN });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA]));
  assert.equal(got[0]?.started, 2);
});

test('counts neither a failed call nor one that was only proposed, started or left unknown', async () => {
  // Bug: any line of a call counts as made in the span, so a refused picture reads as handed over.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  const at = NOW - 4 * HOUR + MIN;
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at, end: 'failed' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + MIN, end: 'proposed' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 2 * MIN, end: 'started' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 3 * MIN, end: 'unknown' });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: at + 4 * MIN, end: 'succeeded' });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA]));
  assert.deepEqual(got[0]?.made, { 'draw.create': 1 });
});

test('counts no call of a skill outside the kinds', async () => {
  // Bug: every skill call counts as made, so a search or a memory read reads as a thing handed over.
  const w = madeWorld();
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.call(CAFE, { turn: 't1', skill: 'memory.search', at: NOW - 4 * HOUR + 2 * MIN });
  await w.call(CAFE, { turn: 't1', skill: 'media.find', at: NOW - 4 * HOUR + 3 * MIN });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA], ['draw.create']));
  assert.deepEqual(got[0]?.made, { 'draw.create': 1 });
});

test('counts a call of an inner turn for no person', async () => {
  // Bug: a call of a heartbeat turn is handed to the person whose line started the turn before it, or to every person.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'ta', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(CAFE, { id: 'th', at: NOW - 3 * HOUR, by: null });
  await w.calls(CAFE, { turn: 'th', skill: 'draw.create', at: NOW - 3 * HOUR, count: 2 });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA, BORIS]));
  assert.deepEqual(got, [{ person: ANNA, made: { 'draw.create': 1 }, started: 1 }]);
});

test('leaves out a person with nothing in the span and keeps the order of the people asked', async () => {
  // Bug: the result follows the order of time or of the counts, a person with nothing gets an empty entry, or a person
  // who was not asked about (Dora) appears because she had things made.
  const w = madeWorld();
  await w.turn(CAFE, { id: 'ta', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 4 * HOUR });
  await w.turn(CAFE, { id: 'tc', at: NOW - 3 * HOUR - 30 * MIN, by: NATIVE[CAROL] });
  await w.calls(CAFE, { turn: 'tc', skill: 'draw.create', at: NOW - 3 * HOUR - 30 * MIN, count: 4 });
  await w.turn(SALON, { id: 'td', at: NOW - 3 * HOUR, by: NATIVE[DORA] });
  await w.call(SALON, { turn: 'td', skill: 'voice.say', at: NOW - 3 * HOUR });
  const got = madeInSpanOf(w.read(), group, span(FROM, TO, [CAROL, BORIS, ANNA]));
  assert.deepEqual(
    got.map((one) => one.person),
    [CAROL, ANNA]
  );
  assert.deepEqual(got[0]?.made, { 'draw.create': 4 });
});

test('counts nothing made in a direct chat for a group context and counts it for that chat', async () => {
  // Bug: the span is read without the context, so a group session learns what she made for a person in private.
  const w = madeWorld();
  await w.turn(DM, { id: 'tb', at: NOW - 4 * HOUR, by: NATIVE[BORIS] });
  await w.call(DM, { turn: 'tb', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(CAFE, { id: 'ta', at: NOW - 3 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 3 * HOUR + MIN });
  const inGroup = madeInSpanOf(w.read(), group, span(FROM, TO, [ANNA, BORIS]));
  assert.deepEqual(
    inGroup.map((one) => one.person),
    [ANNA]
  );
  const inDm = madeInSpanOf(w.read(), dmContext(BORIS, 'discord', DM), span(FROM, TO, [BORIS]));
  assert.deepEqual(inDm, [{ person: BORIS, made: { 'draw.create': 1 }, started: 1 }]);
});
