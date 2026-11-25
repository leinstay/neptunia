// Tests for the participation store (src/memory/participation.ts): recording the
// persona's lines with their surroundings, expiry, a forget, and the read side
// (headlines, selection, the character cut).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTICIPATION_DEFAULTS,
  emptyParticipation,
  expireEpisodes,
  normalizeParticipation,
  recordFollowing,
  recordOwnLine,
} from '../../../src/memory/participation.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const S = { ...PARTICIPATION_DEFAULTS };

/** A member's message `minute` minutes after T0. */
function msg(
  id: string,
  minute: number,
  {
    author = 'u1',
    name = 'Zoé',
    text = `γραμμή ${id}`,
    replyTo = null,
    caption = null,
  }: { author?: string; name?: string; text?: string; replyTo?: string | null; caption?: string | null } = {}
) {
  return { id, ts: T0 + minute * MIN, authorId: author, name, self: false, text, replyTo, caption };
}

/** One of the persona's lines `minute` minutes after T0. */
function own(
  id: string,
  minute: number,
  { text = `απάντηση ${id}`, replyTo = null }: { text?: string; replyTo?: string | null } = {}
) {
  return { id, ts: T0 + minute * MIN, authorId: 'bot', name: 'persona', self: true, text, replyTo, caption: null };
}

/** `value` frozen all the way down, so a mutation throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const ids = (episode: { messages: Array<{ id: string }> }) => episode.messages.map((m) => m.id);
// --- recordOwnLine ---------------------------------------------------------------

test('recordOwnLine: a first line opens an episode with the lines before it, chronological', () => {
  const state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('m4', 4), before: [msg('m2', 2), msg('m1', 1), msg('m3', 3)] },
    S,
    T0 + 5 * MIN
  );
  assert.equal(state.nextId, 2);
  assert.equal(state.episodes.length, 1);
  const [ep] = state.episodes;
  assert.equal(ep.id, 'p1');
  assert.equal(ep.placeId, 'c1');
  assert.deepEqual(ids(ep), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual([ep.startAt, ep.lastAt, ep.lastOwnAt, ep.continues], [T0 + MIN, T0 + 4 * MIN, T0 + 4 * MIN, null]);
  const fourth = ep.messages[3];
  assert.equal(fourth.self, true);
  assert.deepEqual(Object.keys(ep.messages[0]).sort(), [
    'authorId',
    'caption',
    'id',
    'name',
    'replyTo',
    'self',
    'text',
    'ts',
  ]);
});

test('recordOwnLine: only the last linesBefore lines before are taken', () => {
  const before = [msg('m1', 1), msg('m2', 2), msg('m3', 3), msg('m4', 4), msg('m5', 5)];
  const state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o', 6), before },
    { ...S, linesBefore: 2 },
    T0 + 6 * MIN
  );
  assert.deepEqual(ids(state.episodes[0]), ['m4', 'm5', 'o']);
});

test('recordOwnLine: the parent the persona replied to is included once', () => {
  const parent = msg('m0', -30, { author: 'u2', name: 'Andrés' });
  const one = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o', 2, { replyTo: 'm0' }), before: [msg('m1', 1)], parent },
    S,
    T0
  );
  assert.deepEqual(ids(one.episodes[0]), ['m0', 'm1', 'o']);
  const twice = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o', 2), before: [parent, msg('m1', 1)], parent },
    S,
    T0
  );
  assert.deepEqual(ids(twice.episodes[0]), ['m0', 'm1', 'o']);
});

test('recordOwnLine: a line within mergeGapMinutes joins the episode, a later one opens a new one', () => {
  let state = recordOwnLine(emptyParticipation(), { placeId: 'c1', own: own('o1', 0), before: [msg('m1', -1)] }, S, T0);
  state = recordOwnLine(state, { placeId: 'c1', own: own('o2', 9), before: [msg('m2', 8)] }, S, T0 + 9 * MIN);
  assert.equal(state.episodes.length, 1);
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'o1', 'm2', 'o2']);
  const merged = state.episodes[0];
  assert.equal(merged.lastOwnAt, T0 + 9 * MIN);
  state = recordOwnLine(state, { placeId: 'c1', own: own('o3', 40), before: [msg('m3', 39)] }, S, T0 + 40 * MIN);
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(ids(state.episodes[1]), ['m3', 'o3']);
  const opened = state.episodes[1];
  assert.equal(opened.continues, null);
  assert.equal(state.nextId, 3);
  const other = recordOwnLine(state, { placeId: 'c2', own: own('o4', 41) }, S, T0 + 41 * MIN);
  assert.equal(other.episodes.length, 3, 'another channel never joins');
});

test('recordOwnLine: after a long gap a new episode opens even when the before-lines overlap the previous one', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    S,
    T0 + 3 * MIN
  );
  const late = 22 * 60;
  state = recordOwnLine(
    state,
    { placeId: 'c1', own: own('o2', late), before: [msg('m1', 1), msg('m2', 2), own('o1', 3)] },
    S,
    T0 + late * MIN
  );
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'm2', 'o1']);
  assert.deepEqual(ids(state.episodes[1]), ['o2']);
});

test('recordOwnLine: before-lines older than contextMinutes are dropped, recent ones kept, the parent stays', () => {
  const parent = msg('m0', -120, { author: 'u2' });
  const before = [msg('m1', 10), msg('m2', 50), msg('m3', 55)];
  const state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o', 60, { replyTo: 'm0' }), before, parent },
    S,
    T0 + 60 * MIN
  );
  assert.deepEqual(ids(state.episodes[0]), ['m0', 'm2', 'm3', 'o']);
});

test('recordOwnLine: messages already held merge by id, never twice', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    S,
    T0
  );
  state = recordOwnLine(
    state,
    { placeId: 'c1', own: own('o2', 5), before: [msg('m2', 2), own('o1', 3), msg('m4', 4)] },
    S,
    T0
  );
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'm2', 'o1', 'm4', 'o2']);
  const again = recordOwnLine(state, { placeId: 'c1', own: own('o2', 5), before: [msg('m4', 4)] }, S, T0);
  assert.equal(again, state, 'nothing new: the same reference');
});

test('recordOwnLine: past maxMessages a continuation takes what did not fit', () => {
  const settings = { ...S, maxMessages: 4 };
  let state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    settings,
    T0
  );
  state = recordOwnLine(
    state,
    { placeId: 'c1', own: own('o2', 6), before: [msg('m4', 4), msg('m5', 5)] },
    settings,
    T0
  );
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'm2', 'o1', 'm4']);
  assert.deepEqual(ids(state.episodes[1]), ['m5', 'o2']);
  const continuation = state.episodes[1];
  assert.equal(continuation.continues, 'p1');
  state = recordOwnLine(
    state,
    { placeId: 'c1', own: own('o3', 8), before: [msg('m5', 5), msg('m7', 7)] },
    settings,
    T0
  );
  assert.equal(state.episodes.length, 2, 'the continuation is the newest episode and has room');
  assert.deepEqual(ids(state.episodes[1]), ['m5', 'o2', 'm7', 'o3']);
});

// A line of an episode is kept whole, with no length limit.
test('recordOwnLine: texts stay on one line and are kept whole', () => {
  const long = `${'αλφα βήτα\n'.repeat(100)}γάμμα δέλτα έψιλον`;
  const state = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o', 1), before: [msg('m', 0, { text: long, caption: ' une\nimage ' })] },
    S,
    T0
  );
  const [kept] = state.episodes;
  const [first] = kept.messages;
  assert.equal(first.text, `${'αλφα βήτα '.repeat(100)}γάμμα δέλτα έψιλον`);
  assert.equal(first.caption, 'une image');
});

test('recordOwnLine: refuses a line without a channel, a malformed line and one past hours', () => {
  const start = emptyParticipation();
  // @ts-expect-error a missing channel, on purpose: the state is left as it was
  assert.equal(recordOwnLine(start, { placeId: null, own: own('o', 1) }, S, T0), start);
  assert.equal(recordOwnLine(start, { placeId: '', own: own('o', 1) }, S, T0), start);
  assert.equal(recordOwnLine(start, { placeId: 'c1', own: { id: 'o', text: 'χωρίς ώρα' } }, S, T0), start);
  assert.equal(recordOwnLine(start, { placeId: 'c1', own: own('o', 0) }, S, T0 + 73 * HOUR), start);
});

test('recordOwnLine: inputs are never mutated', () => {
  const state = deepFreeze(
    recordOwnLine(emptyParticipation(), { placeId: 'c1', own: own('o1', 1), before: [msg('m1', 0)] }, S, T0)
  );
  const before = deepFreeze([msg('m2', 2), msg('m3', 3)]);
  const line = deepFreeze(own('o2', 4));
  const next = recordOwnLine(state, { placeId: 'c1', own: line, before }, S, T0);
  assert.deepEqual(ids(next.episodes[0]), ['m1', 'o1', 'm2', 'm3', 'o2']);
});

// --- recordFollowing -------------------------------------------------------------

test("recordFollowing: a line after the persona's joins once, only within followMinutes", () => {
  const state = deepFreeze(
    recordOwnLine(emptyParticipation(), { placeId: 'c1', own: own('o1', 0), before: [msg('m1', -1)] }, S, T0)
  );
  const joined = recordFollowing(state, { placeId: 'c1', message: msg('m2', 3) }, S, T0 + 3 * MIN);
  assert.deepEqual(ids(joined.episodes[0]), ['m1', 'o1', 'm2']);
  const joinedEpisode = joined.episodes[0];
  assert.equal(joinedEpisode.lastAt, T0 + 3 * MIN);
  assert.equal(joinedEpisode.lastOwnAt, T0);
  assert.equal(recordFollowing(joined, { placeId: 'c1', message: msg('m3', 4) }, S, T0), joined, 'linesAfter reached');
  assert.equal(recordFollowing(state, { placeId: 'c1', message: msg('m4', 11) }, S, T0), state, 'past followMinutes');
  assert.equal(recordFollowing(state, { placeId: 'c2', message: msg('m5', 1) }, S, T0), state, 'another channel');
  assert.equal(
    recordFollowing(state, { placeId: 'c1', message: own('o2', 1) }, S, T0),
    state,
    "the persona's own line goes elsewhere"
  );
  const two = recordFollowing(joined, { placeId: 'c1', message: msg('m3', 4) }, { ...S, linesAfter: 2 }, T0);
  assert.deepEqual(ids(two.episodes[0]), ['m1', 'o1', 'm2', 'm3']);
});

// --- expireEpisodes --------------------------------------------------------------

test('expireEpisodes: drops episodes past hours, then the oldest over maxStored', () => {
  let state = emptyParticipation();
  for (let i = 0; i < 4; i += 1)
    state = recordOwnLine(state, { placeId: `c${i}`, own: own(`o${i}`, i * 60) }, S, T0 + 4 * HOUR);
  deepFreeze(state);
  const expired = expireEpisodes(state, { ...S, hours: 2 }, T0 + 3 * HOUR + 30 * MIN).state;
  assert.deepEqual(
    expired.episodes.map((ep) => ep.id),
    ['p3', 'p4']
  );
  const capped = expireEpisodes(state, { ...S, maxStored: 3 }, T0 + 4 * HOUR).state;
  assert.deepEqual(
    capped.episodes.map((ep) => ep.id),
    ['p2', 'p3', 'p4']
  );
  assert.equal(capped.nextId, 5);
});

// --- normalizeParticipation ------------------------------------------------------

test('normalizeParticipation: a broken value reads as empty and broken episodes are dropped', () => {
  assert.deepEqual(normalizeParticipation(null), { episodes: [], nextId: 1 });
  assert.deepEqual(normalizeParticipation({ episodes: 'όχι' }), { episodes: [], nextId: 1 });
  const good = recordOwnLine(emptyParticipation(), { placeId: 'c1', own: own('o1', 1), before: [msg('m1', 0)] }, S, T0)
    .episodes[0];
  const value = {
    nextId: 1,
    episodes: [
      good,
      { ...good },
      { ...good, id: 'x' },
      { ...good, id: 'p5', placeId: null },
      { ...good, id: 'p6', messages: [msg('m1', 0)] },
      7,
      { ...good, id: 'p7', messages: [{ id: 'z' }, own('o7', 2), own('o7', 3)] },
    ],
  };
  const result = normalizeParticipation(value);
  assert.deepEqual(
    result.episodes.map((ep) => ep.id),
    ['p1', 'p7']
  );
  assert.deepEqual(ids(result.episodes[1]), ['o7']);
  assert.equal(result.nextId, 8);
  assert.deepEqual(normalizeParticipation(result), result);
});

test('participation: eviction returns the dropped items with their itemId', () => {
  let state = emptyParticipation();
  for (let i = 0; i < 4; i += 1)
    state = recordOwnLine(state, { placeId: `c${i}`, own: own(`o${i}`, i * 60) }, S, T0 + 4 * HOUR);
  state = { ...state, episodes: state.episodes.map((ep) => ({ ...ep, itemId: `pt-${ep.id}` })) };
  deepFreeze(state);
  assert.equal(normalizeParticipation(state).episodes[0].itemId, 'pt-p1', 'normalizing keeps an itemId');
  const { state: next, dropped } = expireEpisodes(state, { ...S, hours: 3, maxStored: 2 }, T0 + 3 * HOUR + 30 * MIN);
  assert.deepEqual(
    next.episodes.map((ep) => ep.itemId),
    ['pt-p3', 'pt-p4']
  );
  assert.deepEqual(
    dropped.map((ep) => ep.itemId),
    ['pt-p1', 'pt-p2'],
    'expired by age, then over the cap'
  );
  const later = recordFollowing(next, { placeId: 'c3', message: msg('m9', 3 * 60 + 1) }, S, T0 + 3 * HOUR + 2 * MIN);
  assert.equal(
    later.episodes.find((ep) => ep.placeId === 'c3')!.itemId,
    'pt-p4',
    'a recorded message keeps the episode itemId'
  );
  assert.equal('itemId' in normalizeParticipation(emptyParticipation()), false);
});
