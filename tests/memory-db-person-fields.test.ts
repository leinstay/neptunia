// src/memory/db/person-fields.ts: the fields of a person's entry the graph reader reads beside the walk. Contract:
//   interestClaimsOf(db: Db, where: { sql: string; params: Array<string | number> }, personId: string, limit: number):
//     Array<{ id: string; text: string; weight: number; lastSeen: string | null }>
//   usualNameOf(db: Db, accounts: ReadonlyArray<string>, placeOk: (placeId: string) => boolean, now: number): string | null
// The reader's own tests (tests/memory-db-mind-read.test.ts) pin the ranking by weight, the audience and the entry; these
// pin the rows each function leaves out and the ties.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { interestClaimsOf, usualNameOf } from '../src/memory/db/person-fields.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import {
  AT,
  NOW,
  addMembership,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const ROOT = rootId('discord', 'g1');
const PERSON = 'person:discord:a1';
const ALL = { sql: '1 = 1', params: [] };

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

/** One person with the account `discord:a1`, under a root with two rooms, `rooms` of which are returned. */
function world(): { w: World; rooms: [string, string] } {
  const w = openWorld();
  worlds.push(w);
  noteInterface(w, 'discord', [{ id: 'g1', name: 'Ágora' }], {
    interface: 'Discord',
    nouns: { server: 'server', channel: 'channel' },
    dm: 'DM',
  });
  addPerson(w.db, {
    id: PERSON,
    accounts: [{ id: 'discord:a1', iface: 'discord', native: 'a1', names: ['Αρίστη'] }],
  });
  const first = addRoom(w.db, { iface: 'discord', native: 'c1', root: ROOT, name: 'λέσχη' });
  const second = addRoom(w.db, { iface: 'discord', native: 'c2', root: ROOT, name: 'αυλή' });
  return { w, rooms: [first, second] };
}

const day = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

type Stored = { text?: string; weight?: number; lastSeen?: string | null; firstSeen?: string | null } & {
  truth?: string | null;
  supersededBy?: string | null;
};

/** An interest claim row about the person, shown and live unless `more` says otherwise. */
function interest(w: World, id: string, more: Stored = {}): void {
  insertRows(w.db, {
    claims: [
      {
        id,
        subject_kind: 'person',
        subject_id: PERSON,
        kind: 'interest',
        text: more.text ?? `ΘΕΜΑ-${id}`,
        weight: more.weight ?? 1,
        first_seen_at: more.firstSeen ?? null,
        last_seen_at: more.lastSeen === undefined ? day(2) : more.lastSeen,
        truth: more.truth === undefined ? 'current' : more.truth,
        superseded_by: more.supersededBy ?? null,
        shown: 1,
        scope_kind: 'group',
        scope_iface: 'discord',
        created_at: AT,
      },
    ],
  });
}

const textsOf = (w: World, limit = 10): Array<string> =>
  interestClaimsOf(w.db, ALL, PERSON, limit).map((claim) => claim.text);

test('a superseded interest claim is left out', () => {
  // Bug: the reader lists a claim a newer one replaced, so she reads the old interest beside its successor.
  const { w } = world();
  interest(w, 'claim:new', { text: 'ΝΕΟ' });
  interest(w, 'claim:old', { text: 'ΠΑΛΙΟ', weight: 9, supersededBy: 'claim:new' });
  assert.deepEqual(textsOf(w), ['ΝΕΟ']);
});

test('a claim whose truth is neither current nor disputed is left out, and one with no truth stays', () => {
  // Bug: the truth is not read, so an interest she holds as false or past is told as one of the person's.
  const { w } = world();
  interest(w, 'claim:a', { text: 'ΤΩΡΙΝΟ', truth: 'current' });
  interest(w, 'claim:b', { text: 'ΑΜΦΙΣΒΗΤΟΥΜΕΝΟ', truth: 'disputed' });
  interest(w, 'claim:c', { text: 'ΧΩΡΙΣ', truth: null });
  interest(w, 'claim:d', { text: 'ΠΑΡΕΛΘΟΝ', truth: 'past' });
  interest(w, 'claim:e', { text: 'ΨΕΥΔΕΣ', truth: 'false' });
  assert.deepEqual([...textsOf(w)].sort(), ['ΑΜΦΙΣΒΗΤΟΥΜΕΝΟ', 'ΤΩΡΙΝΟ', 'ΧΩΡΙΣ']);
});

test('a claim with an empty or blank text is left out', () => {
  // Bug: an empty interest takes a place of the cut and prints a line with nothing in it.
  const { w } = world();
  interest(w, 'claim:a', { text: 'ΜΟΥΣΙΚΗ' });
  interest(w, 'claim:b', { text: '', weight: 9 });
  interest(w, 'claim:c', { text: '   ', weight: 9 });
  assert.deepEqual(textsOf(w), ['ΜΟΥΣΙΚΗ']);
});

test('a limit below 1 gives no claim, a fractional limit counts down', () => {
  // Bug: a limit of 0 is read as no limit, or a limit under 1 still lets the best claim through.
  const { w } = world();
  interest(w, 'claim:a', { text: 'ΕΝΑ', weight: 3 });
  interest(w, 'claim:b', { text: 'ΔΥΟ', weight: 2 });
  for (const limit of [0, 0.5, -1, Number.NaN]) assert.deepEqual(textsOf(w, limit), [], `limit ${limit}`);
  assert.deepEqual(textsOf(w, 1.9), ['ΕΝΑ']);
});

test('two claims of equal weight order by the newer day, whatever their ids', () => {
  // Bug: the tie falls to the order of the rows, so the interest she has not heard of for a year stands first.
  const { w } = world();
  interest(w, 'claim:a', { text: 'ΝΕΟΤΕΡΟ', weight: 2, lastSeen: day(1) });
  interest(w, 'claim:b', { text: 'ΠΑΛΑΙΟΤΕΡΟ', weight: 2, lastSeen: day(60) });
  assert.deepEqual(textsOf(w), ['ΝΕΟΤΕΡΟ', 'ΠΑΛΑΙΟΤΕΡΟ']);
  const other = world();
  interest(other.w, 'claim:a', { text: 'ΠΑΛΑΙΟΤΕΡΟ', weight: 2, lastSeen: day(60) });
  interest(other.w, 'claim:b', { text: 'ΝΕΟΤΕΡΟ', weight: 2, lastSeen: day(1) });
  assert.deepEqual(textsOf(other.w), ['ΝΕΟΤΕΡΟ', 'ΠΑΛΑΙΟΤΕΡΟ']);
});

test('a claim with no last day is dated by its first day', () => {
  // Bug: a claim never seen again is dated at the epoch and falls below every other, however fresh it is.
  const { w } = world();
  interest(w, 'claim:a', { text: 'ΠΑΛΙΟ', weight: 2, lastSeen: day(300) });
  interest(w, 'claim:b', { text: 'ΦΡΕΣΚΟ', weight: 2, lastSeen: null, firstSeen: day(1) });
  assert.deepEqual(textsOf(w), ['ΦΡΕΣΚΟ', 'ΠΑΛΙΟ']);
});

/** Stores `names` as the names the account is addressed by in `place`; `retired` retires the membership. */
function addressed(
  w: World,
  place: string,
  names: Record<string, { score: number; days: number }>,
  retired = false
): void {
  const id = addMembership(w.db, { account: 'discord:a1', place });
  const stored = Object.fromEntries(
    Object.entries(names).map(([name, one]) => [name, { score: one.score, last: day(one.days) }])
  );
  w.db.prepare('UPDATE memberships SET addressed_as = ? WHERE id = ?').run(JSON.stringify(stored), id);
  if (retired) w.db.prepare('UPDATE memberships SET retired_at = ? WHERE id = ?').run(AT, id);
}

const usual = (w: World, ok: (place: string) => boolean = () => true, accounts = ['discord:a1']): string | null =>
  usualNameOf(w.db, accounts, ok, NOW);

test('a membership in a place the filter refuses does not count', () => {
  // Bug: the name comes from every membership, so what people call her in a room this turn may not see shows in another.
  const { w, rooms } = world();
  addressed(w, rooms[0], { Κρυφός: { score: 9, days: 1 } });
  addressed(w, rooms[1], { Φανερός: { score: 1, days: 1 } });
  assert.equal(
    usual(w, (place) => place === rooms[1]),
    'Φανερός'
  );
  assert.equal(
    usual(w, () => false),
    null
  );
});

test('the same name in two memberships counts by its best entry, not by their sum', () => {
  // Bug: the entries of a name are added or the last one read wins, so a name used in two rooms outranks one used a lot
  // in one, or the weaker entry hides the stronger.
  const { w, rooms } = world();
  addressed(w, rooms[0], { Κοινός: { score: 2, days: 1 }, Μοναδικός: { score: 3, days: 1 } });
  addressed(w, rooms[1], { Κοινός: { score: 1.5, days: 1 } });
  assert.equal(usual(w), 'Μοναδικός');
  const again = world();
  addressed(again.w, again.rooms[0], { Κοινός: { score: 1, days: 1 } });
  addressed(again.w, again.rooms[1], { Κοινός: { score: 4, days: 1 }, Άλλος: { score: 3, days: 1 } });
  assert.equal(usual(again.w), 'Κοινός');
});

test('a retired membership does not count', () => {
  // Bug: the names of a membership she left are still read, so a name from a room long gone wins.
  const { w, rooms } = world();
  addressed(w, rooms[0], { Παλιός: { score: 9, days: 1 } }, true);
  addressed(w, rooms[1], { Τωρινός: { score: 1, days: 1 } });
  assert.equal(usual(w), 'Τωρινός');
});

test('a person with no account has no usual name', () => {
  // Bug: an empty account list builds `IN ()` and throws, or reads every membership of everyone.
  const { w, rooms } = world();
  addressed(w, rooms[0], { Κάποιος: { score: 9, days: 1 } });
  assert.equal(
    usual(w, () => true, []),
    null
  );
});

test('a membership holding stored text that is not a map of names is skipped', () => {
  // Bug: one hand-edited row throws and the whole entry of the person is lost.
  const { w, rooms } = world();
  const id = addMembership(w.db, { account: 'discord:a1', place: rooms[0] });
  w.db.prepare('UPDATE memberships SET addressed_as = ? WHERE id = ?').run('not json', id);
  addressed(w, rooms[1], { Έγκυρος: { score: 1, days: 1 } });
  assert.equal(usual(w), 'Έγκυρος');
});
