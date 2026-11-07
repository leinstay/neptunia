// The ring of her lookups (src/turn/calls.ts) and the `<recall>` it renders (src/turn/request/recall-block.ts): what she
// looked up herself in the last turns of a place, kept until its anchor messages leave the window (plan
// 2026-11-06-turn-frame, slice 4 (a), "The ordinary turn" and "How memory fills"). Contract:
//   Lookup = { turnId; at: number; tool; args: Record<string, unknown>; place: { id; path: Array<string> }; status;
//     extract; sourceIds: Array<string>; anchorMessageIds: Array<string> }
//   createLookupRing(seed: Array<Lookup>) -> { note(lookup, settings: { maxItems; extractChars }),
//     forPlace(placeId, window: Array<{ id; replyTo: string | null }>, now): Array<Lookup>, drop(placeId, tool, args) }
//   recallBlockOf(lookups: Array<Lookup>, window: { retired: Set<string> }, labels: Labels, timezone: string): string
// One entry per place, tool and args whatever the order of the args' keys: a repeated lookup replaces the earlier one.
// `forPlace` keeps an entry while one of its anchors is in the window, and a line of the window that replies to an
// anchor adds its own id to the anchors. `recallBlockOf` leaves out an entry whose sources are all retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookupRing } from '../src/turn/calls.ts';
import type { Lookup } from '../src/turn/calls.ts';
import { recallBlockOf } from '../src/turn/request/recall-block.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const MIN = 60_000;
/** The owner's values for `context.recall`. */
const SETTINGS = { maxItems: 6, extractChars: 1200 };
const ROOM = { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] };

function lookup(over: Partial<Lookup> = {}): Lookup {
  return {
    turnId: 'turn:7',
    at: NOW - 10 * MIN,
    tool: 'memory.search',
    args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ', place: 'λέσχη' },
    place: ROOM,
    status: 'ok',
    extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
    sourceIds: ['src:fake:m50:1:seen'],
    anchorMessageIds: ['m10'],
    ...over,
  };
}

const lines = (...ids: Array<string>) => ids.map((id) => ({ id, replyTo: null }));

test('a lookup of one turn renders in <recall> of the next with where from, what, the query, the status and the extract', () => {
  // Bug: the next turn sees the call mark and no result, so she searches again or invents the answer.
  const ring = createLookupRing([]);
  ring.note(lookup(), SETTINGS);
  const kept = ring.forPlace('place:room', lines('m10', 'm11'), NOW);
  const text = recallBlockOf(kept, { retired: new Set() }, shippedLabels, 'UTC');
  for (const value of ['γενικά', 'memory.search', 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ', 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'])
    assert.ok(text.includes(value), value);
  const failed = recallBlockOf([lookup({ status: 'failed' })], { retired: new Set() }, shippedLabels, 'UTC');
  assert.notEqual(text, failed, 'the status is rendered');
});

test('a lookup leaves the ring when its anchor leaves the window', () => {
  // Bug: lookups pile up for ever, a hundred turns giving a hundred extracts.
  const ring = createLookupRing([]);
  ring.note(lookup(), SETTINGS);
  assert.deepEqual(ring.forPlace('place:room', lines('m11', 'm12'), NOW), []);
});

test('a lookup made in one place is not read back in another', () => {
  // Bug: a lookup made in a one-to-one chat surfaces in a group.
  const ring = createLookupRing([]);
  ring.note(lookup({ place: { id: 'fake:dm:1234', path: ['fake', 'private', '1234'] } }), SETTINGS);
  assert.deepEqual(ring.forPlace('place:room', lines('m10'), NOW), []);
});

test('a repeated lookup replaces the earlier one and takes its newer anchor, whatever the order of the arguments', () => {
  // Bug: the same search twice fills two entries, or the replacement keeps the old anchor and leaves too early.
  const ring = createLookupRing([]);
  ring.note(lookup(), SETTINGS);
  ring.note(
    lookup({ turnId: 'turn:9', args: { place: 'λέσχη', query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' }, anchorMessageIds: ['m20'] }),
    SETTINGS
  );
  const kept = ring.forPlace('place:room', lines('m10', 'm20'), NOW);
  assert.deepEqual(
    kept.map((one) => one.turnId),
    ['turn:9']
  );
  assert.deepEqual(
    ring.forPlace('place:room', lines('m20'), NOW).map((one) => one.turnId),
    ['turn:9']
  );
});

test('a place keeps at most maxItems lookups, the oldest anchor dropped first', () => {
  // Bug: the cap is not applied, or it drops the newest lookup she just made.
  const ring = createLookupRing([]);
  const ids = ['m1', 'm2', 'm3', 'm4'];
  for (const [i, id] of ids.entries()) {
    ring.note(lookup({ turnId: `turn:${i}`, args: { query: `q${i}` }, anchorMessageIds: [id] }), {
      ...SETTINGS,
      maxItems: 3,
    });
  }
  const kept = ring.forPlace('place:room', lines(...ids), NOW).map((one) => one.turnId);
  assert.deepEqual(kept.sort(), ['turn:1', 'turn:2', 'turn:3']);
});

test('an extract longer than extractChars is kept cut to extractChars', () => {
  // Bug: one long result fills the request in every later turn of the place.
  const ring = createLookupRing([]);
  ring.note(lookup({ extract: 'α'.repeat(5000) }), { ...SETTINGS, extractChars: 300 });
  const [kept] = ring.forPlace('place:room', lines('m10'), NOW);
  assert.ok(kept !== undefined && kept.extract.length <= 300 && kept.extract.length > 0);
});

test('a ring seeded from the journal returns the seeded lookup, so a restart keeps it', () => {
  // Bug: the seed is ignored and every restart forgets what she looked up.
  const ring = createLookupRing([lookup()]);
  assert.deepEqual(
    ring.forPlace('place:room', lines('m10'), NOW).map((one) => one.turnId),
    ['turn:7']
  );
});

test('a reply to the line of her lookup keeps the entry after that line left the window', () => {
  // Bug: the follow-up "and what about the other one?" arrives just as the lookup is forgotten.
  const ring = createLookupRing([]);
  ring.note(lookup({ anchorMessageIds: ['m10'] }), SETTINGS);
  const reply = [{ id: 'm60', replyTo: 'm10' }];
  assert.equal(ring.forPlace('place:room', reply, NOW).length, 1);
  // The reply became an anchor of its own: it holds the entry with no parent in sight.
  assert.equal(ring.forPlace('place:room', lines('m60'), NOW).length, 1);
});

test('drop removes the one lookup it names and keeps the others of the place', () => {
  // Bug: drop empties the whole place, or removes nothing.
  const ring = createLookupRing([]);
  ring.note(lookup(), SETTINGS);
  ring.note(lookup({ turnId: 'turn:8', args: { query: 'ΑΛΛΟ' } }), SETTINGS);
  ring.drop('place:room', 'memory.search', { place: 'λέσχη', query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' });
  assert.deepEqual(
    ring.forPlace('place:room', lines('m10'), NOW).map((one) => one.turnId),
    ['turn:8']
  );
});

test('a lookup whose sources are all retired is absent from <recall>', () => {
  // Bug: a deleted message keeps being quoted back to her as if it still stood.
  const text = recallBlockOf([lookup()], { retired: new Set(['src:fake:m50:1:seen']) }, shippedLabels, 'UTC');
  assert.ok(!text.includes('ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'));
});

test('a lookup with one of two sources retired stays in <recall>', () => {
  // Bug: one retired source throws away a result the other source still supports.
  const both = lookup({ sourceIds: ['src:fake:m50:1:seen', 'src:fake:m51:1:seen'] });
  const text = recallBlockOf([both], { retired: new Set(['src:fake:m50:1:seen']) }, shippedLabels, 'UTC');
  assert.ok(text.includes('ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'));
});
