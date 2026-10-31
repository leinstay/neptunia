// Tests for the participation store (src/memory/participation.js): recording the
// persona's lines with their surroundings, expiry, a forget, and the read side
// (headlines, selection, the character cut).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARTICIPATION_DEFAULTS,
  cutEpisode,
  earlierEpisodes,
  emptyParticipation,
  episodeHeadlines,
  expireEpisodes,
  normalizeParticipation,
  participationSettings,
  purgeParticipationFor,
  recordFollowing,
  recordOwnLine,
  selectEpisodes,
} from '../src/memory/participation.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const S = { ...PARTICIPATION_DEFAULTS };

/** A member's message `minute` minutes after T0. */
function msg(id, minute, { author = 'u1', name = 'Zoé', text = `γραμμή ${id}`, replyTo = null, caption = null } = {}) {
  return { id, ts: T0 + minute * MIN, authorId: author, name, self: false, text, replyTo, caption };
}

/** One of the persona's lines `minute` minutes after T0. */
function own(id, minute, { text = `απάντηση ${id}`, replyTo = null } = {}) {
  return { id, ts: T0 + minute * MIN, authorId: 'bot', name: 'persona', self: true, text, replyTo, caption: null };
}

/** `value` frozen all the way down, so a mutation throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const ids = (episode) => episode.messages.map((m) => m.id);

// --- settings ------------------------------------------------------------------

test('participation: defaults equal config.json and missing keys fall back to them', () => {
  // PR 7c: the shipped settings live in config/config.json.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  assert.deepEqual({ ...PARTICIPATION_DEFAULTS }, config.participation);
  assert.equal(config.features.participation, true);
  assert.deepEqual(participationSettings({}), { ...PARTICIPATION_DEFAULTS });
  assert.deepEqual(participationSettings(config), { ...PARTICIPATION_DEFAULTS });
  assert.deepEqual(participationSettings({ participation: { hours: 24, shown: 2 } }), {
    ...PARTICIPATION_DEFAULTS,
    hours: 24,
    shown: 2,
  });
  assert.ok(Object.isFrozen(PARTICIPATION_DEFAULTS));
});

// --- recordOwnLine ---------------------------------------------------------------

test('recordOwnLine: a first line opens an episode with the lines before it, chronological', () => {
  const state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('m4', 4), before: [msg('m2', 2), msg('m1', 1), msg('m3', 3)] },
    S,
    T0 + 5 * MIN
  );
  assert.equal(state.nextId, 2);
  assert.equal(state.episodes.length, 1);
  const [ep] = state.episodes;
  assert.equal(ep.id, 'p1');
  assert.equal(ep.channelId, 'c1');
  assert.deepEqual(ids(ep), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual([ep.startAt, ep.lastAt, ep.lastOwnAt, ep.continues], [T0 + MIN, T0 + 4 * MIN, T0 + 4 * MIN, null]);
  assert.equal(ep.messages[3].self, true);
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
    { channelId: 'c1', own: own('o', 6), before },
    { ...S, linesBefore: 2 },
    T0 + 6 * MIN
  );
  assert.deepEqual(ids(state.episodes[0]), ['m4', 'm5', 'o']);
});

test('recordOwnLine: the parent she replied to is included once', () => {
  const parent = msg('m0', -30, { author: 'u2', name: 'Andrés' });
  const one = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o', 2, { replyTo: 'm0' }), before: [msg('m1', 1)], parent },
    S,
    T0
  );
  assert.deepEqual(ids(one.episodes[0]), ['m0', 'm1', 'o']);
  const twice = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o', 2), before: [parent, msg('m1', 1)], parent },
    S,
    T0
  );
  assert.deepEqual(ids(twice.episodes[0]), ['m0', 'm1', 'o']);
});

test('recordOwnLine: a line within mergeGapMinutes joins the episode, a later one opens a new one', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 0), before: [msg('m1', -1)] },
    S,
    T0
  );
  state = recordOwnLine(state, { channelId: 'c1', own: own('o2', 9), before: [msg('m2', 8)] }, S, T0 + 9 * MIN);
  assert.equal(state.episodes.length, 1);
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'o1', 'm2', 'o2']);
  assert.equal(state.episodes[0].lastOwnAt, T0 + 9 * MIN);
  state = recordOwnLine(state, { channelId: 'c1', own: own('o3', 40), before: [msg('m3', 39)] }, S, T0 + 40 * MIN);
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(ids(state.episodes[1]), ['m3', 'o3']);
  assert.equal(state.episodes[1].continues, null);
  assert.equal(state.nextId, 3);
  const other = recordOwnLine(state, { channelId: 'c2', own: own('o4', 41) }, S, T0 + 41 * MIN);
  assert.equal(other.episodes.length, 3, 'another channel never joins');
});

test('recordOwnLine: after a long gap a new episode opens even when the before-lines overlap the previous one', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    S,
    T0 + 3 * MIN
  );
  const late = 22 * 60;
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o2', late), before: [msg('m1', 1), msg('m2', 2), own('o1', 3)] },
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
    { channelId: 'c1', own: own('o', 60, { replyTo: 'm0' }), before, parent },
    S,
    T0 + 60 * MIN
  );
  assert.deepEqual(ids(state.episodes[0]), ['m0', 'm2', 'm3', 'o']);
});

test('recordOwnLine: messages already held merge by id, never twice', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    S,
    T0
  );
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o2', 5), before: [msg('m2', 2), own('o1', 3), msg('m4', 4)] },
    S,
    T0
  );
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'm2', 'o1', 'm4', 'o2']);
  const again = recordOwnLine(state, { channelId: 'c1', own: own('o2', 5), before: [msg('m4', 4)] }, S, T0);
  assert.equal(again, state, 'nothing new: the same reference');
});

test('recordOwnLine: past maxMessages a continuation takes what did not fit', () => {
  const settings = { ...S, maxMessages: 4 };
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 3), before: [msg('m1', 1), msg('m2', 2)] },
    settings,
    T0
  );
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o2', 6), before: [msg('m4', 4), msg('m5', 5)] },
    settings,
    T0
  );
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(ids(state.episodes[0]), ['m1', 'm2', 'o1', 'm4']);
  assert.deepEqual(ids(state.episodes[1]), ['m5', 'o2']);
  assert.equal(state.episodes[1].continues, 'p1');
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o3', 8), before: [msg('m5', 5), msg('m7', 7)] },
    settings,
    T0
  );
  assert.equal(state.episodes.length, 2, 'the continuation is the newest episode and has room');
  assert.deepEqual(ids(state.episodes[1]), ['m5', 'o2', 'm7', 'o3']);
});

test('recordOwnLine: texts stay on one line and are cut to maxTextChars at a word boundary', () => {
  const long = 'αλφα βήτα\nγάμμα δέλτα έψιλον';
  const state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o', 1), before: [msg('m', 0, { text: long, caption: ' une\nimage ' })] },
    { ...S, maxTextChars: 16 },
    T0
  );
  const [first] = state.episodes[0].messages;
  assert.equal(first.text, 'αλφα βήτα γάμμα');
  assert.equal(first.caption, 'une image');
});

test('recordOwnLine: refuses a line without a channel, a malformed line and one past hours', () => {
  const start = emptyParticipation();
  assert.equal(recordOwnLine(start, { channelId: null, own: own('o', 1) }, S, T0), start);
  assert.equal(recordOwnLine(start, { channelId: '', own: own('o', 1) }, S, T0), start);
  assert.equal(recordOwnLine(start, { channelId: 'c1', own: { id: 'o', text: 'χωρίς ώρα' } }, S, T0), start);
  assert.equal(recordOwnLine(start, { channelId: 'c1', own: own('o', 0) }, S, T0 + 73 * HOUR), start);
});

test('recordOwnLine: inputs are never mutated', () => {
  const state = deepFreeze(
    recordOwnLine(emptyParticipation(), { channelId: 'c1', own: own('o1', 1), before: [msg('m1', 0)] }, S, T0)
  );
  const before = deepFreeze([msg('m2', 2), msg('m3', 3)]);
  const line = deepFreeze(own('o2', 4));
  const next = recordOwnLine(state, { channelId: 'c1', own: line, before }, S, T0);
  assert.deepEqual(ids(next.episodes[0]), ['m1', 'o1', 'm2', 'm3', 'o2']);
});

// --- recordFollowing -------------------------------------------------------------

test('recordFollowing: a line after hers joins once, only within followMinutes', () => {
  const state = deepFreeze(
    recordOwnLine(emptyParticipation(), { channelId: 'c1', own: own('o1', 0), before: [msg('m1', -1)] }, S, T0)
  );
  const joined = recordFollowing(state, { channelId: 'c1', message: msg('m2', 3) }, S, T0 + 3 * MIN);
  assert.deepEqual(ids(joined.episodes[0]), ['m1', 'o1', 'm2']);
  assert.equal(joined.episodes[0].lastAt, T0 + 3 * MIN);
  assert.equal(joined.episodes[0].lastOwnAt, T0);
  assert.equal(
    recordFollowing(joined, { channelId: 'c1', message: msg('m3', 4) }, S, T0),
    joined,
    'linesAfter reached'
  );
  assert.equal(recordFollowing(state, { channelId: 'c1', message: msg('m4', 11) }, S, T0), state, 'past followMinutes');
  assert.equal(recordFollowing(state, { channelId: 'c2', message: msg('m5', 1) }, S, T0), state, 'another channel');
  assert.equal(
    recordFollowing(state, { channelId: 'c1', message: own('o2', 1) }, S, T0),
    state,
    'her own line goes elsewhere'
  );
  const two = recordFollowing(joined, { channelId: 'c1', message: msg('m3', 4) }, { ...S, linesAfter: 2 }, T0);
  assert.deepEqual(ids(two.episodes[0]), ['m1', 'o1', 'm2', 'm3']);
});

// --- expireEpisodes --------------------------------------------------------------

test('expireEpisodes: drops episodes past hours, then the oldest over maxStored', () => {
  let state = emptyParticipation();
  for (let i = 0; i < 4; i += 1)
    state = recordOwnLine(state, { channelId: `c${i}`, own: own(`o${i}`, i * 60) }, S, T0 + 4 * HOUR);
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

// --- purgeParticipationFor -------------------------------------------------------

test('purgeParticipationFor: takes a member out and drops the episodes left without her line', () => {
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 2), before: [msg('m1', 0), msg('m2', 1, { author: 'u2' })] },
    S,
    T0
  );
  state = recordOwnLine(state, { channelId: 'c2', own: own('o2', 2), before: [msg('m3', 1)] }, S, T0);
  state = deepFreeze({
    ...state,
    episodes: [...state.episodes, { ...state.episodes[1], id: 'p9', messages: [msg('m9', 0)] }],
  });
  const { value, removed } = purgeParticipationFor(state, 'u1');
  assert.equal(removed, 2);
  assert.deepEqual(
    value.episodes.map((ep) => [ep.id, ids(ep)]),
    [
      ['p1', ['m2', 'o1']],
      ['p2', ['o2']],
    ]
  );
  assert.equal(value.episodes[0].startAt, T0 + MIN);
});

// --- normalizeParticipation ------------------------------------------------------

test('normalizeParticipation: a broken value reads as empty and broken episodes are dropped', () => {
  assert.deepEqual(normalizeParticipation(null), { episodes: [], nextId: 1 });
  assert.deepEqual(normalizeParticipation({ episodes: 'όχι' }), { episodes: [], nextId: 1 });
  const good = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 1), before: [msg('m1', 0)] },
    S,
    T0
  ).episodes[0];
  const value = {
    nextId: 1,
    episodes: [
      good,
      { ...good },
      { ...good, id: 'x' },
      { ...good, id: 'p5', channelId: null },
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

// --- episodeHeadlines ------------------------------------------------------------

function threeChannels() {
  let state = emptyParticipation();
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o1', 0), before: [msg('m1', -1, { text: 'πρώτη ερώτηση' })] },
    S,
    T0
  );
  state = recordOwnLine(state, { channelId: 'c2', own: own('o2', 60) }, S, T0);
  state = recordOwnLine(state, { channelId: 'c3', own: own('o3', 120), before: [msg('m3', 119)] }, S, T0);
  state = recordOwnLine(state, { channelId: 'c1', own: own('o4', 180), before: [msg('m4', 179)] }, S, T0);
  return deepFreeze(state);
}

test('episodeHeadlines: newest first, skipping the current channel and refused audiences', () => {
  const state = threeChannels();
  const now = T0 + 200 * MIN;
  const heads = episodeHeadlines(state, { excludeChannelId: 'c3', audience: (id) => id !== 'c2', now }, S);
  assert.deepEqual(
    heads.map((h) => h.id),
    ['p4', 'p1']
  );
  assert.deepEqual(heads[1], {
    id: 'p1',
    channelId: 'c1',
    lastOwnAt: T0,
    ageMs: 200 * MIN,
    memberLine: 'πρώτη ερώτηση',
    selfLine: 'απάντηση o1',
    memberLines: 'πρώτη ερώτηση',
    selfLines: 'απάντηση o1',
  });
  assert.deepEqual(
    episodeHeadlines(state, { audience: () => true, now }, S).map((h) => h.memberLine),
    ['γραμμή m4', 'γραμμή m3', null, 'πρώτη ερώτηση']
  );
  assert.deepEqual(episodeHeadlines(state, { now }, S), [], 'no audience, nothing offered');
});

test('episodeHeadlines: lines are cut to 120 characters at a word boundary', () => {
  const long = Array(40).fill('λέξη').join(' ');
  const state = recordOwnLine(emptyParticipation(), { channelId: 'c1', own: own('o', 1, { text: long }) }, S, T0);
  const [head] = episodeHeadlines(state, { audience: () => true, now: T0 }, S);
  assert.ok([...head.selfLine].length <= 120);
  assert.ok(head.selfLine.endsWith('λέξη'));
});

test('episodeHeadlines: selfLines and memberLines carry every line in order, cut per line and overall', () => {
  const word = 'λέξη';
  const long = Array(40).fill(word).join(' ');
  let state = recordOwnLine(
    emptyParticipation(),
    { channelId: 'c1', own: own('o1', 1, { text: 'πρώτη' }), before: [msg('m1', 0, { text: 'ερώτηση' })] },
    S,
    T0
  );
  state = recordOwnLine(
    state,
    { channelId: 'c1', own: own('o2', 2, { text: long }), before: [msg('m2', 1, { text: long })] },
    S,
    T0
  );
  for (let i = 3; i < 12; i += 1)
    state = recordOwnLine(
      state,
      { channelId: 'c1', own: own(`o${i}`, i, { text: long }), before: [msg(`m${i}`, i - 1, { text: long })] },
      S,
      T0
    );
  const [head] = episodeHeadlines(state, { audience: () => true, now: T0 + 20 * MIN }, S);
  assert.ok(head.selfLines.startsWith(`πρώτη / ${word}`), 'own lines in order, joined with a slash');
  assert.ok([...head.selfLines].length <= 320 && [...head.selfLines].length > 200);
  assert.ok(head.selfLines.endsWith(word), 'cut at a word boundary');
  assert.ok(head.memberLines.startsWith(`ερώτηση / ${word}`));
  assert.ok([...head.memberLines].length <= 200);
  assert.ok(head.memberLines.endsWith(word));
  assert.ok(head.selfLines.split(' / ').every((part) => [...part].length <= 90));
});

test('episodeHeadlines: no member lines gives an empty memberLines', () => {
  const state = recordOwnLine(emptyParticipation(), { channelId: 'c1', own: own('o1', 1) }, S, T0);
  const [head] = episodeHeadlines(state, { audience: () => true, now: T0 }, S);
  assert.equal(head.memberLines, '');
  assert.equal(head.selfLines, 'απάντηση o1');
});

// --- selectEpisodes --------------------------------------------------------------

test('selectEpisodes: picks first, then recency, at most perChannel, grouped by channel', () => {
  const state = threeChannels();
  const now = T0 + 200 * MIN;
  const all = () => true;
  const view = (groups) => groups.map((g) => [g.channelId, g.episodes.map((ep) => ep.id)]);

  assert.deepEqual(view(selectEpisodes(state, { audience: all, now }, { ...S, shown: 2 })), [
    ['c1', ['p4']],
    ['c3', ['p3']],
  ]);
  assert.deepEqual(
    view(selectEpisodes(state, { pickedIds: ['p2', 'nope', 'p1', 'p2'], audience: all, now }, { ...S, shown: 3 })),
    [
      ['c1', ['p1', 'p4']],
      ['c2', ['p2']],
    ]
  );
  assert.deepEqual(view(selectEpisodes(state, { pickedIds: ['p1'], audience: all, now }, { ...S, perChannel: 1 })), [
    ['c3', ['p3']],
    ['c2', ['p2']],
    ['c1', ['p1']],
  ]);
  assert.deepEqual(
    view(selectEpisodes(state, { pickedIds: ['p4'], excludeChannelId: 'c1', audience: (id) => id !== 'c2', now }, S)),
    [['c3', ['p3']]]
  );
  assert.deepEqual(
    selectEpisodes(state, { audience: all, now: T0 + 80 * HOUR }, S),
    [],
    'expired episodes are never shown'
  );
  const [group] = selectEpisodes(state, { pickedIds: ['p3'], audience: all, now }, { ...S, shown: 1 });
  assert.deepEqual(group.episodes[0], state.episodes[2]);
});

// --- cutEpisode ------------------------------------------------------------------

/** An episode of ten 10-character messages: hers at index 4 (replying to index 1) and 8. */
function longEpisode() {
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    const text = `μήνυμα ${String(i).padStart(2, '0')}`; // 10 characters
    messages.push(
      i === 4 || i === 8 ? { ...own(`k${i}`, i, { text, replyTo: i === 4 ? 'k1' : null }) } : msg(`k${i}`, i, { text })
    );
  }
  return deepFreeze({ id: 'p1', channelId: 'c1', messages });
}

const shape = (items) => items.map((item) => ('skipped' in item ? `-${item.skipped}` : item.message.id));

test('cutEpisode: every message when the texts and captions fit', () => {
  const episode = longEpisode();
  const items = cutEpisode(episode, { maxChars: 100 });
  assert.deepEqual(
    shape(items),
    episode.messages.map((m) => m.id)
  );
  assert.equal(items[0].message, episode.messages[0]);
  const withCaption = deepFreeze({
    messages: [msg('a', 0, { text: 'όχι', caption: 'μια εικόνα' }), own('b', 1, { text: 'ναι' })],
  });
  assert.deepEqual(shape(cutEpisode(withCaption, { maxChars: 16 })), ['a', 'b']);
  assert.deepEqual(shape(cutEpisode(withCaption, { maxChars: 15 })), ['-1', 'b'], 'the caption counts');
});

test('cutEpisode: a priority cut keeps her lines, their parents, matched lines, the edges, with skipped markers', () => {
  const episode = longEpisode();
  // her lines and the parent first: k1, k4, k8 (30 characters); then the edges k0 and k9.
  assert.deepEqual(shape(cutEpisode(episode, { maxChars: 30 })), ['-1', 'k1', '-2', 'k4', '-3', 'k8', '-1']);
  assert.deepEqual(shape(cutEpisode(episode, { maxChars: 50 })), ['k0', 'k1', '-2', 'k4', '-3', 'k8', 'k9']);
  // keepIds k6: k5, k6, k7 come before the edges.
  assert.deepEqual(shape(cutEpisode(episode, { maxChars: 60, keepIds: ['k6'] })), [
    '-1',
    'k1',
    '-2',
    'k4',
    'k5',
    'k6',
    'k7',
    'k8',
    '-1',
  ]);
  // the fill takes the rest in chronological order.
  assert.deepEqual(shape(cutEpisode(episode, { maxChars: 70 })), ['k0', 'k1', 'k2', 'k3', 'k4', '-3', 'k8', 'k9']);
  for (const maxChars of [0, 5, 25, 35, 55, 95]) {
    const kept = cutEpisode(episode, { maxChars, keepIds: ['k6'] }).filter((item) => item.message);
    assert.ok(
      kept.reduce((sum, item) => sum + [...item.message.text].length, 0) <= maxChars,
      `never above ${maxChars}`
    );
  }
  assert.deepEqual(shape(cutEpisode(episode, { maxChars: 0 })), ['-10']);
});

test('participation: eviction returns the dropped items with their itemId', () => {
  let state = emptyParticipation();
  for (let i = 0; i < 4; i += 1)
    state = recordOwnLine(state, { channelId: `c${i}`, own: own(`o${i}`, i * 60) }, S, T0 + 4 * HOUR);
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
  const later = recordFollowing(next, { channelId: 'c3', message: msg('m9', 3 * 60 + 1) }, S, T0 + 3 * HOUR + 2 * MIN);
  assert.equal(
    later.episodes.find((ep) => ep.channelId === 'c3').itemId,
    'pt-p4',
    'a recorded message keeps the episode itemId'
  );
  assert.equal('itemId' in normalizeParticipation(emptyParticipation()), false);
});

// --- earlierEpisodes -------------------------------------------------------------

/** Three episodes of c1 and one of c2: p1 at minutes 0-2, p2 at 20-24, p3 at 40-44 (c1), p4 at 21 (c2). */
function earlierState() {
  return deepFreeze({
    nextId: 5,
    episodes: [
      { id: 'p1', channelId: 'c1', continues: null, messages: [msg('a0', 0), own('a1', 1), msg('a2', 2)] },
      {
        id: 'p2',
        channelId: 'c1',
        continues: null,
        messages: [msg('b0', 20), own('b1', 21), msg('b2', 22), own('b3', 24)],
      },
      { id: 'p3', channelId: 'c1', continues: 'p2', messages: [msg('c0', 40), own('c1', 41), msg('c2', 44)] },
      { id: 'p4', channelId: 'c2', continues: null, messages: [own('d1', 21)] },
    ],
  });
}

const earlierView = (episodes) => episodes.map((ep) => [ep.id, ids(ep)]);

test('earlierEpisodes: only the channel, only lines older than the window start, oldest first', () => {
  const state = earlierState();
  const now = T0 + 60 * MIN;
  const s = { ...S, earlierHours: 3, earlierShown: 3 };
  // The window starts at minute 22: p3 is whole in the window, p2 is cut at b2, p1 is gone whole.
  assert.deepEqual(earlierView(earlierEpisodes(state, { channelId: 'c1', before: T0 + 22 * MIN, now }, s)), [
    ['p1', ['a0', 'a1', 'a2']],
    ['p2', ['b0', 'b1']],
  ]);
  // A window that starts before every line cuts nothing.
  assert.deepEqual(earlierEpisodes(state, { channelId: 'c1', before: T0 - MIN, now }, s), []);
  // Another channel's episodes never come.
  assert.deepEqual(earlierView(earlierEpisodes(state, { channelId: 'c2', before: T0 + 60 * MIN, now }, s)), [
    ['p4', ['d1']],
  ]);
});

test('earlierEpisodes: the age bound drops older lines, the count keeps the newest episodes', () => {
  const state = earlierState();
  const before = T0 + 50 * MIN;
  // One hour later, a 1-hour bound keeps lines from minute 30 on (now = minute 90).
  assert.deepEqual(
    earlierView(
      earlierEpisodes(
        state,
        { channelId: 'c1', before, now: T0 + 90 * MIN },
        { ...S, earlierHours: 1, earlierShown: 3 }
      )
    ),
    [['p3', ['c0', 'c1', 'c2']]]
  );
  // A bound that cuts inside an episode keeps its younger lines (now = minute 81, bound from minute 21).
  assert.deepEqual(
    earlierView(
      earlierEpisodes(
        state,
        { channelId: 'c1', before, now: T0 + 81 * MIN },
        { ...S, earlierHours: 1, earlierShown: 3 }
      )
    ),
    [
      ['p2', ['b1', 'b2', 'b3']],
      ['p3', ['c0', 'c1', 'c2']],
    ]
  );
  assert.deepEqual(
    earlierView(
      earlierEpisodes(
        state,
        { channelId: 'c1', before, now: T0 + 60 * MIN },
        { ...S, earlierHours: 3, earlierShown: 2 }
      )
    ),
    [
      ['p2', ['b0', 'b1', 'b2', 'b3']],
      ['p3', ['c0', 'c1', 'c2']],
    ]
  );
});

test('earlierEpisodes: off with earlierHours 0, earlierShown 0, no channel or no window start', () => {
  const state = earlierState();
  const view = { channelId: 'c1', before: T0 + 60 * MIN, now: T0 + 60 * MIN };
  assert.deepEqual(earlierEpisodes(state, view, { ...S, earlierHours: 0, earlierShown: 3 }), []);
  assert.deepEqual(earlierEpisodes(state, view, { ...S, earlierHours: 3, earlierShown: 0 }), []);
  assert.deepEqual(
    earlierEpisodes(state, { ...view, channelId: null }, { ...S, earlierHours: 3, earlierShown: 3 }),
    []
  );
  assert.deepEqual(
    earlierEpisodes(state, { ...view, before: undefined }, { ...S, earlierHours: 3, earlierShown: 3 }),
    []
  );
});

test('earlierEpisodes: the same store and window start give the same episodes as the clock moves', () => {
  const state = earlierState();
  const s = { ...S, earlierHours: 3, earlierShown: 3 };
  const at = (minute) => earlierEpisodes(state, { channelId: 'c1', before: T0 + 22 * MIN, now: T0 + minute * MIN }, s);
  assert.deepEqual(at(60), at(90));
});
