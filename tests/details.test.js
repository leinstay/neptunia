// Tests for src/memory/details.js: applyDetailOps (add/seen/remove, the
// confirmation weight/gap rule shared with interests, id assignment/reuse,
// clamping, eviction) and normalizeDetails (validates stored items). Pure,
// no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDetailOps, normalizeDetails } from '../src/memory/details.js';
import { isConfirmed } from '../src/memory/interests.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z
const HOUR = 3_600_000;

function opts(overrides = {}) {
  return { maxDetails: 15, fieldChars: 200, confirmGapHours: 12, seenAt: NOW, nextId: 1, ...overrides };
}

// ---- applyDetailOps: add, a brand new item -----------------------------------

test('applyDetailOps: add of new text inserts an item with weight 1 and a fresh id', () => {
  const { items, nextId } = applyDetailOps([], { add: ['Owns a cat'] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
  assert.equal(items[0].text, 'Owns a cat');
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].firstSeen, new Date(NOW).toISOString());
  assert.equal(items[0].lastSeen, new Date(NOW).toISOString());
  assert.equal(nextId, 2);
});

test('applyDetailOps: add with sure:false starts at weight 0', () => {
  const { items } = applyDetailOps([], { add: [{ text: 'Maybe owns a cat', sure: false }] }, opts());
  assert.equal(items[0].weight, 0);
  assert.equal(isConfirmed(items[0]), false);
});

// ---- applyDetailOps: identity / dedupe on add --------------------------------

test('applyDetailOps: add of already-known text (trimmed, whitespace-collapsed, lowercased) is a sighting, not a duplicate', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { add: ['  owns   a CAT '] }, opts({ nextId: 2 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Owns a cat', 'the originally stored text is kept, not the new casing');
  assert.equal(items[0].weight, 2);
});

// ---- applyDetailOps: the confirmation weight / gap rule ----------------------

test('applyDetailOps: a sighting close in time to lastSeen does not bump the weight', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const { items } = applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 2 * HOUR, nextId: 2 }));
  assert.equal(items[0].weight, 1);
});

test('applyDetailOps: a sighting past confirmGapHours away bumps the weight once', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const { items } = applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 13 * HOUR, nextId: 2 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: sure:false on an EXISTING item changes nothing at all', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 3, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' }];
  const { items } = applyDetailOps(existing, { add: [{ text: 'Owns a cat', sure: false }] }, opts({ seenAt: NOW, nextId: 2 }));
  assert.deepEqual(items, existing);
});

// ---- applyDetailOps: seen -----------------------------------------------------

test('applyDetailOps: seen by numeric id is a sighting', () => {
  const existing = [{ id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { seen: [3] }, opts({ nextId: 4 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: seen by exact stored text is a sighting', () => {
  const existing = [{ id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { seen: ['owns a cat'] }, opts({ nextId: 4 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: seen of an unknown id/text never creates one', () => {
  const { items } = applyDetailOps([], { seen: [99] }, opts());
  assert.deepEqual(items, []);
});

// ---- applyDetailOps: remove ----------------------------------------------------

test('applyDetailOps: remove by numeric id deletes the matching item', () => {
  const existing = [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: 'a', lastSeen: null },
  ];
  const { items } = applyDetailOps(existing, { remove: [1] }, opts({ nextId: 3 }));
  assert.deepEqual(items.map((i) => i.id), [2]);
});

test('applyDetailOps: remove by exact stored text deletes the matching item', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { remove: ['Owns a cat'] }, opts({ nextId: 2 }));
  assert.deepEqual(items, []);
});

// ---- id assignment / never reused --------------------------------------------

test('applyDetailOps: ids increment across calls and are never reused after a remove', () => {
  let result = applyDetailOps([], { add: ['a', 'b'] }, opts({ nextId: 1 }));
  assert.deepEqual(result.items.map((i) => i.id), [1, 2]);
  assert.equal(result.nextId, 3);

  result = applyDetailOps(result.items, { remove: [1] }, opts({ nextId: result.nextId }));
  assert.deepEqual(result.items.map((i) => i.id), [2]);

  result = applyDetailOps(result.items, { add: ['c'] }, opts({ nextId: result.nextId }));
  assert.deepEqual(result.items.map((i) => i.id), [2, 3], 'id 1 is never reused');
  assert.equal(result.nextId, 4);
});

test('applyDetailOps: nextId defaults to 1 when omitted or invalid', () => {
  assert.equal(applyDetailOps([], { add: ['a'] }, { seenAt: NOW }).nextId, 2);
  assert.equal(applyDetailOps([], { add: ['a'] }, { seenAt: NOW, nextId: 0 }).items[0].id, 1);
});

// ---- clamping / rejection -----------------------------------------------------

test('applyDetailOps: text is clamped tolerantly to fieldChars (a single long word hard-cuts at the tolerance ceiling)', () => {
  const { items } = applyDetailOps([], { add: ['x'.repeat(60)] }, opts({ fieldChars: 5, clampTolerance: 1.25 }));
  assert.equal(items[0].text.length, 6, '5 * the tolerance 1.25, floored');
});

test('applyDetailOps: an empty/whitespace-only text is rejected', () => {
  const { items } = applyDetailOps([], { add: ['   ', ''] }, opts());
  assert.deepEqual(items, []);
});

// ---- eviction: lowest weight first (the age tie-break is tested in interests.test.js) ----

test('applyDetailOps: evicts the lowest weight first once over maxDetails', () => {
  const existing = [
    { id: 1, text: 'a', weight: 5, firstSeen: 'x', lastSeen: '2026-01-01T00:00:00.000Z' },
    { id: 2, text: 'b', weight: 1, firstSeen: 'x', lastSeen: '2026-01-02T00:00:00.000Z' },
    { id: 3, text: 'c', weight: 3, firstSeen: 'x', lastSeen: '2026-01-03T00:00:00.000Z' },
  ];
  const { items } = applyDetailOps(existing, { add: ['d'] }, opts({ maxDetails: 3, nextId: 4 }));
  assert.deepEqual(items.map((i) => i.text).sort(), ['a', 'c', 'd']);
});

// ---- storage cap vs shown cap, and rank-driven eviction -----------------------

test('applyDetailOps: the storage cap is max(maxDetailsStored, maxDetails) -- a smaller stored cap never wins', () => {
  const existing = [
    { id: 1, text: 'a', weight: 1, firstSeen: 'x', lastSeen: null },
    { id: 2, text: 'b', weight: 1, firstSeen: 'x', lastSeen: null },
  ];
  const { items } = applyDetailOps(existing, {}, opts({ maxDetails: 15, maxDetailsStored: 1, nextId: 3 }));
  assert.equal(items.length, 2, 'stored cap floored at the shown cap (15), so 2 items are never touched');
});

test('applyDetailOps: a shorter detailHalfLifeDays makes recency dominate sooner than a longer one', () => {
  const olderHeavier = [
    { id: 1, text: 'a', weight: 5, firstSeen: 'x', lastSeen: '2026-08-01T00:00:00.000Z' },
    { id: 2, text: 'b', weight: 1, firstSeen: 'x', lastSeen: '2026-09-20T00:00:00.000Z' },
  ];
  // A very short half-life (7 days) makes the ~50-day recency gap dwarf the
  // weight gap, evicting the older-heavier item first; the config.json
  // default (720 days) does not -- weight still wins.
  const shortHalfLife = applyDetailOps(olderHeavier, {}, opts({ maxDetails: 1, halfLifeDays: 7, nextId: 3 }));
  assert.deepEqual(shortHalfLife.items.map((i) => i.text), ['b']);

  const longHalfLife = applyDetailOps(olderHeavier, {}, opts({ maxDetails: 1, halfLifeDays: 720, nextId: 3 }));
  assert.deepEqual(longHalfLife.items.map((i) => i.text), ['a']);
});

// ---- garbage tolerance ----------------------------------------------------------

test('applyDetailOps: garbage ops never throw and change nothing', () => {
  const existing = [{ id: 1, text: 'a', weight: 1, firstSeen: 'x', lastSeen: null }];
  for (const garbage of [null, 'not an object', { add: 'nope' }, { add: [null, 42, {}] }]) {
    const { items } = applyDetailOps(existing, garbage, opts({ nextId: 2 }));
    assert.equal(items.length, 1, `garbage ${JSON.stringify(garbage)} must not throw or add anything`);
  }
});

test('applyDetailOps: existing undefined/non-array is tolerated', () => {
  const { items } = applyDetailOps(undefined, { add: ['first ever detail'] }, opts());
  assert.equal(items.length, 1);
});

test('applyDetailOps: does not mutate the existing array or its items', () => {
  const existing = [{ id: 1, text: 'a', weight: 1, firstSeen: 'x', lastSeen: null }];
  const copy = existing.map((i) => ({ ...i }));
  applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 100 * HOUR, nextId: 2 }));
  assert.deepEqual(existing, copy);
});

// ---- normalizeDetails: array validation -------------------------------------

test('normalizeDetails: startId offsets the ids assigned to entries missing one', () => {
  const { items, nextId } = normalizeDetails([{ text: 'a' }, { text: 'b' }], 5);
  assert.deepEqual(items.map((i) => i.id), [5, 6]);
  assert.equal(nextId, 7);
});

test('normalizeDetails: an array already in the item shape passes through, keeping valid ids', () => {
  const { items, nextId } = normalizeDetails([{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }], 1);
  assert.deepEqual(items, [{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }]);
  assert.equal(nextId, 8, 'the sequence continues past the highest id seen');
});

test('normalizeDetails: item-shaped entries missing a valid id get one assigned fresh', () => {
  const { items } = normalizeDetails([{ text: 'Owns a cat' }], 1);
  assert.deepEqual(items, [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null }]);
});

test('normalizeDetails: garbage entries (including a bare string) never throw, valid ones survive', () => {
  const { items } = normalizeDetails([null, 42, {}, { text: '' }, 'Owns a cat', { text: 'Plays guitar' }], 1);
  assert.deepEqual(items.map((i) => i.text), ['Plays guitar']);
});

test('normalizeDetails: null/undefined/number/string/object all yield an empty list', () => {
  assert.deepEqual(normalizeDetails(null).items, []);
  assert.deepEqual(normalizeDetails('Owns a cat, plays guitar').items, []);
  assert.deepEqual(normalizeDetails({ not: 'an array' }).items, []);
});

// ---- the optional `from` (who taught an item; used by guild.learned) ---------

test('applyDetailOps: an add item keeps a non-empty string from, trimmed', () => {
  const { items } = applyDetailOps([], { add: [{ text: 'Friday is τυρόπιτα day', from: ' <@322222222222222222> ' }] }, opts());
  assert.equal(items[0].from, '<@322222222222222222>');
});

test('applyDetailOps: a missing, empty or non-string from is dropped, the item still lands', () => {
  for (const from of [undefined, '   ', 42, ['<@322222222222222222>']]) {
    const { items } = applyDetailOps([], { add: [{ text: 'Café closes at nine', from }] }, opts());
    assert.equal(items.length, 1, `from ${JSON.stringify(from)} must not reject the item`);
    assert.equal('from' in items[0], false, `from ${JSON.stringify(from)} must not be stored`);
  }
});

test('applyDetailOps: sure:false with from starts at weight 0 and keeps the from', () => {
  const { items } = applyDetailOps([], { add: [{ text: 'Maybe the kettle is Ὠκεανός', from: '<@322222222222222222>', sure: false }] }, opts());
  assert.equal(items[0].weight, 0);
  assert.equal(items[0].from, '<@322222222222222222>');
});

test('applyDetailOps: a sighting of a known item never rewrites its stored from', () => {
  const existing = [{ id: 1, text: 'Café closes at nine', weight: 1, firstSeen: 'a', lastSeen: null, from: '<@322222222222222222>' }];
  const { items } = applyDetailOps(existing, { add: [{ text: 'café closes at nine', from: '<@422222222222222222>' }] }, opts({ nextId: 2 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].from, '<@322222222222222222>');
  assert.equal(items[0].weight, 2);
});

test('normalizeDetails: a valid string from survives, a garbage from is dropped', () => {
  const { items } = normalizeDetails(
    [
      { id: 1, text: 'Café closes at nine', weight: 2, firstSeen: 'a', lastSeen: 'b', from: '<@322222222222222222>' },
      { id: 2, text: 'Friday is τυρόπιτα day', weight: 1, firstSeen: 'a', lastSeen: 'b', from: 42 },
      { id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: 'b', from: '  ' },
    ],
    1,
  );
  assert.deepEqual(items[0], { id: 1, text: 'Café closes at nine', weight: 2, firstSeen: 'a', lastSeen: 'b', from: '<@322222222222222222>' });
  assert.equal('from' in items[1], false);
  assert.equal('from' in items[2], false);
});

test('details: eviction returns the dropped items with their itemId', () => {
  const old = { id: 1, text: 'έχει γάτα', weight: 1, firstSeen: '2025-01-01T00:00:00.000Z', lastSeen: '2025-01-01T00:00:00.000Z', itemId: 'dt-old' };
  const fresh = { id: 2, text: 'ζει στη Λυών', weight: 3, firstSeen: '2026-09-20T00:00:00.000Z', lastSeen: '2026-09-20T00:00:00.000Z', itemId: 'dt-fresh' };
  const removed = { id: 3, text: 'πίνει café', weight: 2, firstSeen: '2026-09-19T00:00:00.000Z', lastSeen: '2026-09-19T00:00:00.000Z', itemId: 'dt-removed' };
  const result = applyDetailOps([old, fresh, removed], { remove: [3] }, opts({ maxDetails: 1, halfLifeDays: 30, nextId: 4 }));
  assert.deepEqual(result.items, [fresh]);
  assert.deepEqual(result.dropped, [removed, old]);
  assert.deepEqual(applyDetailOps([fresh], { seen: [2] }, opts({ nextId: 4 })).dropped, []);

  const normalized = normalizeDetails([old]);
  assert.equal(normalized.items[0].itemId, 'dt-old', 'normalizing keeps an itemId');
  assert.equal('itemId' in normalizeDetails([{ id: 1, text: 'χωρίς' }]).items[0], false, 'and adds none');
});

// ---- validity: supersedes / validFrom -------------------------------------------

test('details: a joke correction closes with validTo equal to validFrom', () => {
  const old = { id: 1, text: 'Lives in Lyon', weight: 1, firstSeen: '2026-09-19T10:00:00.000Z', lastSeen: '2026-09-19T10:00:00.000Z', itemId: 'dt-old', validFrom: '2026-09-19' };
  const { items, closed, dropped } = applyDetailOps(
    [old],
    { add: [{ text: 'Lives in Nice', supersedes: 'dt-old', validFrom: '2026-09-19' }] },
    opts({ nextId: 2, mintId: () => 'dt-new' }),
  );
  assert.deepEqual(items.map((item) => item.text), ['Lives in Nice']);
  assert.equal(items[0].validFrom, '2026-09-19');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].validTo, closed[0].validFrom, 'it was never true');
  assert.equal(closed[0].supersededBy, 'dt-new');
  assert.deepEqual(dropped, []);

  // By the numeric id the input view shows, the same.
  const byId = applyDetailOps([old], { add: [{ text: 'Lives in Nice', supersedes: 1 }] }, opts({ nextId: 2, mintId: () => 'dt-new' }));
  assert.equal(byId.closed[0].validTo, '2026-09-21', 'no validFrom: the batch day');
  // Old items load unchanged; validity fields survive.
  assert.deepEqual(normalizeDetails([{ ...old, validTo: '2026-09-20', supersededBy: 'dt-new' }]).items, [{ ...old, validTo: '2026-09-20', supersededBy: 'dt-new' }]);
});
