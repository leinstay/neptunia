// Round trips of src/memory/db/map/private.ts: a member's private layer <-> rows. The public profile has its own write
// kind (memory-db-account-profile.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as privateLayer from '../src/memory/db/map/private.ts';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.ts';

const ID = '100000000000000001';
const PRIVATE_REL = `private/${ID}.json`;
const CTX = { iface: 'discord' };
const PERSON = `person:discord:${ID}`;

const layer = () => ({
  relationship: 'Trusted.',
  relationshipScore: 30,
  relationshipWrittenAt: '2026-10-02T00:00:00.000Z',
  interests: [{ topic: 'music', note: 'n', weight: 1, firstSeen: 'a', lastSeen: 'b' }],
  details: [{ id: 1, text: 'secret plan', weight: 1, firstSeen: 'a', lastSeen: 'b', itemId: 'pd-1' }],
  detailsSeq: 1,
  episodes: [
    { date: '2026-10-02', what: 'confided', quote: 'q', feeling: 'f', weight: 1, addedAt: '2026-10-02T00:00:00.000Z' },
  ],
  affinity: {
    score: 10,
    reason: 'r',
    history: [{ ts: 't', delta: 1, appliedDelta: 1, score: 1, reason: 'x' }],
    decayedAt: 'd',
  },
  firstSeen: 'a',
  lastSeen: 'b',
  replies: { day: '2026-10-02', count: 2, noticedDay: '2026-10-01' },
  buffer: [{ any: 'thing' }],
});

test("a private layer round trips with every row scoped to that member's DM and no people row", () => {
  const rows = assertRoundTrip(privateLayer, PRIVATE_REL, layer(), CTX);
  assert.equal(rows.people, undefined);
  assert.equal(rows.accounts, undefined);
  for (const table of ['claims', 'episodes', 'descriptions', 'affinity_events']) {
    assert.ok(rows[table].length > 0, table);
    for (const row of rows[table]) assert.deepEqual([row.scope_kind, row.scope_dm], ['dm', PERSON], table);
  }
  assert.deepEqual(
    rows.descriptions.map((d) => d.field),
    ['relationship']
  );
  assert.deepEqual([rows.operational[0].kind, rows.operational[0].owner], ['private', PERSON]);
});

test('private layers that are empty or odd come back as they were', () => {
  for (const value of [
    {},
    { relationship: '', interests: [], details: [], episodes: [] },
    { affinity: null, details: 'x', buffer: [] },
    { affinity: {} },
  ]) {
    assert.deepEqual(roundTrip(privateLayer, PRIVATE_REL, value, CTX).back, value, JSON.stringify(value));
  }
});

test('the generated fixtures with every key path of the live private files round trip', () => {
  for (const [index, value] of generated('private').entries()) {
    assertRoundTrip(privateLayer, `private/${index}.json`, plain(value), CTX, `generated private ${index}`);
  }
});
