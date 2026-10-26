// Tests for src/memory/aliases.js: applyAliasOps -- add/sighting/remove,
// ignoring an alias equal to a display name, clamping, rank-based eviction.
// Pure, no I/O. Shares its confirmation/gap/rank mechanics with
// src/memory/interests.js#applyRankedOps -- see tests/interests.test.js for
// the exhaustive coverage of that shared core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAliasOps } from '../src/memory/aliases.js';
import { topByRank } from '../src/memory/ranking.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const HOUR = 3_600_000;

function opts(overrides = {}) {
  return { maxAliases: 5, maxAliasesStored: 15, confirmGapHours: 12, seenAt: NOW, ...overrides };
}

test('applyAliasOps: add of a new alias inserts it with weight 1', () => {
  const items = applyAliasOps([], { add: ['Vertex'] }, ['LongDisplayName'], opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Vertex');
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].firstSeen, new Date(NOW).toISOString());
});

test('applyAliasOps: add of an already-known alias (case-insensitive) is a sighting', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW - 20 * HOUR).toISOString() }];
  const items = applyAliasOps(existing, { add: ['vertex'] }, [], opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Vertex', 'original casing kept');
  assert.equal(items[0].weight, 2);
});

test('applyAliasOps: a sighting inside the confirmGapHours window does not bump the weight', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const items = applyAliasOps(existing, { add: ['Vertex'] }, [], opts({ seenAt: NOW + 2 * HOUR }));
  assert.equal(items[0].weight, 1);
});

test('applyAliasOps: an add equal (case-insensitively) to a stored display name is ignored outright', () => {
  const items = applyAliasOps([], { add: ['prime', 'Vertex'] }, ['Prime'], opts());
  assert.deepEqual(
    items.map((i) => i.name),
    ['Vertex'],
    'the one matching a display name never becomes an alias'
  );
});

test('applyAliasOps: an add equal to a display name does not even count as a sighting on an existing alias', () => {
  // A stored alias that later becomes identical to a (new) display name stays
  // as stored, and an add of that name, in any casing, is filtered before it
  // could sight it. The stored lastSeen is past confirmGapHours, so a sighting
  // would bump the weight and move lastSeen.
  const lastSeen = new Date(NOW - 20 * HOUR).toISOString();
  const existing = [{ name: 'Prime', weight: 3, firstSeen: lastSeen, lastSeen }];
  const items = applyAliasOps(existing, { add: ['Prime', 'prime'] }, ['Prime'], opts());
  assert.equal(items.length, 1, 'the stored alias is kept');
  assert.equal(items[0].weight, 3, 'no sighting: the weight does not move');
  assert.equal(items[0].lastSeen, lastSeen, 'no sighting: lastSeen does not move');
});

test('applyAliasOps: remove deletes the alias, case-insensitively', () => {
  const existing = [
    { name: 'Vertex', weight: 3, firstSeen: 'a', lastSeen: 'a' },
    { name: 'Prime', weight: 1, firstSeen: 'a', lastSeen: 'a' },
  ];
  const items = applyAliasOps(existing, { remove: ['vertex'] }, [], opts());
  assert.deepEqual(
    items.map((i) => i.name),
    ['Prime']
  );
});

test('applyAliasOps: an alias is clamped to 40 characters', () => {
  const items = applyAliasOps([], { add: ['x'.repeat(60)] }, [], opts());
  assert.equal(items[0].name.length, 40);
});

test('applyAliasOps: eviction keeps the top maxAliasesStored/maxAliases by rank', () => {
  const existing = [
    { name: 'a', weight: 5, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    { name: 'b', weight: 1, firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' },
    { name: 'c', weight: 3, firstSeen: '2026-01-03T00:00:00.000Z', lastSeen: '2026-01-03T00:00:00.000Z' },
  ];
  const items = applyAliasOps(existing, { add: ['d'] }, [], opts({ maxAliases: 3, maxAliasesStored: 3 }));
  assert.deepEqual(items.map((i) => i.name).sort(), ['a', 'c', 'd']);
});

test('applyAliasOps: the storage cap is max(maxAliasesStored, maxAliases) -- a smaller stored cap never wins', () => {
  const existing = [
    { name: 'a', weight: 1, firstSeen: 'x', lastSeen: '2026-01-01T00:00:00.000Z' },
    { name: 'b', weight: 1, firstSeen: 'x', lastSeen: '2026-01-02T00:00:00.000Z' },
  ];
  const items = applyAliasOps(existing, {}, [], opts({ maxAliases: 5, maxAliasesStored: 1 }));
  assert.equal(items.length, 2, 'stored cap floored at the shown cap, so both survive');
});

test('applyAliasOps: garbage ops never throw and change nothing', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: 'a' }];
  for (const garbage of [null, 'nope', { add: 'nope' }, { add: [null, 42, {}] }]) {
    const items = applyAliasOps(existing, garbage, [], opts());
    assert.equal(items.length, 1, `garbage ${JSON.stringify(garbage)} must not throw or add anything`);
  }
});

test('applyAliasOps: with halfLifeDays, top-ranked aliases can be selected the same way as interests', () => {
  const existing = [
    {
      name: 'Ancient nickname',
      weight: 10,
      firstSeen: '2021-01-01T00:00:00.000Z',
      lastSeen: '2021-01-01T00:00:00.000Z',
    },
    { name: 'Fresh nickname', weight: 2, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-01T00:00:00.000Z' },
  ];
  const capOne = { maxAliases: 1, maxAliasesStored: 1 };
  const decayed = applyAliasOps(existing, {}, [], opts({ ...capOne, halfLifeDays: 180 }));
  assert.deepEqual(
    decayed.map((i) => i.name),
    ['Fresh nickname'],
    'five years of silence sink the heavier alias under eviction'
  );
  assert.deepEqual(decayed, topByRank(existing, 1, 180), 'the same pick as topByRank, the ranking interests use');
  const undecayed = applyAliasOps(existing, {}, [], opts(capOne));
  assert.deepEqual(
    undecayed.map((i) => i.name),
    ['Ancient nickname'],
    'without halfLifeDays the heavier alias stays'
  );
});

test('aliases: eviction returns the dropped items with their itemId', () => {
  const old = {
    name: 'Λένα',
    weight: 1,
    firstSeen: '2025-01-01T00:00:00.000Z',
    lastSeen: '2025-01-01T00:00:00.000Z',
    itemId: 'al-old',
  };
  const result = applyAliasOps(
    [old],
    { add: ['Élise'] },
    [],
    opts({ maxAliases: 1, maxAliasesStored: 1, halfLifeDays: 30 })
  );
  assert.deepEqual(
    result.map((a) => a.name),
    ['Élise']
  );
  assert.deepEqual(result.dropped, [old]);
  assert.equal(result.dropped[0].itemId, 'al-old');
});

test('aliases: a supersedes op closes the old nickname', () => {
  const old = {
    name: 'Vex',
    weight: 2,
    firstSeen: '2026-09-01T10:00:00.000Z',
    lastSeen: '2026-09-10T10:00:00.000Z',
    itemId: 'al-old',
  };
  const items = applyAliasOps(
    [old],
    { add: [{ name: 'Vertex', supersedes: 'al-old' }] },
    ['LongDisplayName'],
    opts({ mintId: () => 'al-new' })
  );
  assert.deepEqual(
    items.map((item) => item.name),
    ['Vertex']
  );
  assert.deepEqual(items.closed, [{ ...old, validTo: '2026-09-21', supersededBy: 'al-new' }]);
  // By name, too; a plain string add stays a plain add.
  const byName = applyAliasOps(
    [old],
    { add: [{ name: 'Vertex', supersedes: 'vex' }, 'Vx'] },
    [],
    opts({ mintId: () => 'al-new' })
  );
  assert.deepEqual(
    byName.map((item) => item.name),
    ['Vertex', 'Vx']
  );
  assert.equal(byName.closed[0].name, 'Vex');
});
