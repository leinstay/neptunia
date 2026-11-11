import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_RING_PLACES, SEED_RING_TURNS, createSeedRing, seedRefsOf } from '../src/turn/seed-ring.ts';
import type { Mind, PersonEntry, PlaceEntry } from '../src/memory/db/mind-read.ts';

const person = (personId: string, extra: Partial<PersonEntry> = {}): PersonEntry =>
  ({ personId, nodeId: `person:${personId}`, evidence: 'word', candidate: false, ...extra }) as PersonEntry;
const place = (placeId: string, extra: Partial<PlaceEntry> = {}): PlaceEntry =>
  ({ placeId, nodeId: `place:${placeId}`, evidence: 'place', candidate: false, ...extra }) as PlaceEntry;
const mindOf = (people: Array<PersonEntry>, places: Array<PlaceEntry>): Mind => ({
  people,
  places,
  interfaces: [],
  lore: [],
  recent: [],
  found: [],
  leftOut: {},
  reads: [],
});

test('a turn of a place gives its seeds to the next turn of that place and to no other place', () => {
  const ring = createSeedRing();
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p1' }]);
  assert.deepEqual(ring.previous('c1', 't2'), [{ kind: 'person', rowId: 'p1' }]);
  assert.deepEqual(ring.previous('c2', 't2'), []);
});

test('a turn reads none of its own seeds back, and a second note of the same turn replaces the first', () => {
  const ring = createSeedRing();
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p1' }]);
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p2' }]);
  assert.deepEqual(ring.previous('c1', 't1'), []);
  assert.deepEqual(ring.previous('c1', 't2'), [{ kind: 'person', rowId: 'p2' }]);
});

test('a node two earlier turns raised is given once, and a turn older than the last few leaves the ring', () => {
  const ring = createSeedRing();
  ring.note('c1', 't0', [{ kind: 'person', rowId: 'old' }]);
  for (let n = 1; n <= SEED_RING_TURNS; n += 1) ring.note('c1', `t${n}`, [{ kind: 'place', rowId: 'c1' }]);
  assert.deepEqual(ring.previous('c1', 'next'), [{ kind: 'place', rowId: 'c1' }]);
});

test('the place noted longest ago leaves the ring when it holds too many places', () => {
  const ring = createSeedRing();
  for (let n = 0; n <= SEED_RING_PLACES; n += 1) ring.note(`c${n}`, 't', [{ kind: 'person', rowId: `p${n}` }]);
  assert.deepEqual(ring.previous('c0', 'next'), []);
  assert.deepEqual(ring.previous(`c${SEED_RING_PLACES}`, 'next'), [{ kind: 'person', rowId: `p${SEED_RING_PLACES}` }]);
});

test('the seeds of a mind are its people and places a line raised, no candidate and nothing an edge brought', () => {
  const mind = mindOf(
    [person('named'), person('guess', { candidate: true }), person('carried', { evidence: 'edge' })],
    [place('here'), place('prose', { evidence: 'prose' })]
  );
  assert.deepEqual(seedRefsOf(mind), [
    { kind: 'person', rowId: 'named' },
    { kind: 'place', rowId: 'here' },
  ]);
});
