// Tests for src/memory/lore.ts: upsertLore (identity, owner protection, key
// normalization, eviction). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertLore, type LoreEntry } from '../../../src/memory/lore.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';

/** An entry as `upsertLore` stores it: the owner's fields and the short id it assigns. */
type Stored = LoreEntry & { id: string };
const upsert = (...args: Parameters<typeof upsertLore>) =>
  wrongly<Omit<ReturnType<typeof upsertLore>, 'entries'> & { entries: Array<Stored> }>(upsertLore(...args));

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function entry(overrides: Record<string, Untyped> = {}): Stored {
  return {
    id: 'id1',
    title: 'The Great Migration',
    keys: ['migration', 'the move'],
    text: 'The server moved house in spring.',
    always: false,
    source: 'analyzer',
    weight: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---- upsertLore: identity + basic insert -----------------------------------

test('upsertLore: inserts a new entry, assigning a short stable id', () => {
  const result = upsert([], [{ title: 'New Event', keys: ['event'], text: 'Something happened.' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.upserted, 1);
  assert.equal(result.entries.length, 1);
  const firstEntry = result.entries[0];
  assert.equal(typeof firstEntry.id, 'string');
  assert.ok(firstEntry.id.length > 0);
  assert.equal(firstEntry.source, 'analyzer');
  assert.equal(firstEntry.createdAt, new Date(NOW).toISOString());
});

test('upsertLore: identity is the case-insensitive, trimmed title', () => {
  const existing = [entry({ title: 'The Great Migration' })];
  const result = upsert(wrongly(existing), [{ title: '  the GREAT migration  ', keys: ['xx'], text: 'updated text' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.entries.length, 1, 'same identity, no duplicate row');
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.text, 'updated text');
});

test('upsertLore: an analyzer update replaces keys/text of an ANALYZER entry wholesale', () => {
  const existing = [entry({ keys: ['old-key'], text: 'old text' })];
  const result = upsert(wrongly(existing), [{ title: 'The Great Migration', keys: ['new-key'], text: 'new text' }], {
    source: 'analyzer',
    now: NOW,
  });
  const firstEntry = result.entries[0];
  assert.deepEqual(firstEntry.keys, ['new-key']);
  assert.equal(firstEntry.text, 'new text');
  assert.equal(firstEntry.id, 'id1', 'the id survives an update');
});

// ---- owner protection ---------------------------------------------------------

test('upsertLore: an analyzer update never touches an existing OWNER entry', () => {
  const existing = [entry({ source: 'owner', text: 'owner-written text', always: true })];
  const result = upsert(
    wrongly(existing),
    [{ title: 'The Great Migration', keys: ['x'], text: 'analyzer tries to overwrite' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 0);
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.text, 'owner-written text');
  assert.equal(firstEntry.source, 'owner');
});

test('upsertLore: an owner update overwrites an existing ANALYZER entry and takes ownership', () => {
  const existing = [entry({ source: 'analyzer' })];
  const result = upsert(
    wrongly(existing),
    [{ title: 'The Great Migration', keys: ['owner-key'], text: 'owner text', always: true }],
    {
      source: 'owner',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.source, 'owner');
  assert.equal(firstEntry.always, true);
  assert.deepEqual(firstEntry.keys, ['owner-key']);
});

test('upsertLore: an owner update can overwrite another owner entry (re-editing)', () => {
  const existing = [entry({ source: 'owner', always: true, text: 'first version' })];
  const result = upsert(
    wrongly(existing),
    [{ title: 'The Great Migration', keys: ['xx'], text: 'second version', always: false }],
    {
      source: 'owner',
      now: NOW,
    }
  );
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.text, 'second version');
  assert.equal(firstEntry.always, false);
});

// ---- a re-send that changes nothing ---------------------------------------------

test('upsertLore: an analyzer re-send identical after normalisation is not stamped and counts 0', () => {
  const existing = [entry()];
  const result = upsert(
    wrongly(existing),
    [{ title: 'The Great Migration', keys: ['  Migration ', 'THE MOVE'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 0);
  assert.deepEqual(result.entries, existing, 'the stored entry, updatedAt included, is left as it was');
});

// A lore text is kept whole, whatever its length.
test('upsertLore: a long text is kept whole on the first write, a re-send counts 0 and a rewrite is kept whole too', () => {
  const first = upsert([], [{ title: 'X', keys: ['valid'], text: 'x'.repeat(1000) }], {
    source: 'analyzer',
    now: NOW,
  }).entries;
  assert.equal(first[0].text, 'x'.repeat(1000));
  const same = upsert(first, [{ title: 'X', keys: ['valid'], text: 'x'.repeat(1000) }], {
    source: 'analyzer',
    now: NOW + 60_000,
  });
  assert.equal(same.upserted, 0);
  const firstEntry = same.entries[0];
  assert.equal(firstEntry.updatedAt, new Date(NOW).toISOString());
  const rewritten = upsert(first, [{ title: 'X', keys: ['valid'], text: 'x'.repeat(2000) }], {
    source: 'analyzer',
    now: NOW + 60_000,
  });
  assert.equal(rewritten.upserted, 1);
  const entriesFirstEntry = rewritten.entries[0];
  assert.equal(entriesFirstEntry.text, 'x'.repeat(2000));
});

test('upsertLore: an analyzer re-send that changes only the keys is stamped and counted', () => {
  const result = upsert(
    [entry()],
    [{ title: 'The Great Migration', keys: ['migration'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  const firstEntry = result.entries[0];
  assert.deepEqual(firstEntry.keys, ['migration']);
  assert.equal(firstEntry.updatedAt, new Date(NOW).toISOString());
});

test('upsertLore: an analyzer re-send that changes only the title casing is stamped and counted', () => {
  const result = upsert(
    [entry()],
    [{ title: 'the great migration', keys: ['migration', 'the move'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.title, 'the great migration');
  assert.equal(firstEntry.updatedAt, new Date(NOW).toISOString());
});

test('upsertLore: an owner re-save of an identical owner entry is still stamped and counted (an explicit save)', () => {
  const existing = [entry({ source: 'owner', always: true })];
  const result = upsert(
    wrongly(existing),
    [
      {
        title: 'The Great Migration',
        keys: ['migration', 'the move'],
        text: 'The server moved house in spring.',
        always: true,
      },
    ],
    {
      source: 'owner',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.updatedAt, new Date(NOW).toISOString());
});

// ---- key normalization / rejection ------------------------------------------

test('upsertLore: keys are lowercased, trimmed, de-duplicated, kept 1-8', () => {
  const result = upsert(
    [],
    [{ title: 'X', keys: ['  Foo  ', 'foo', 'BAR', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'], text: 'text' }],
    { source: 'analyzer', now: NOW }
  );
  const firstEntry = result.entries[0];
  assert.deepEqual(firstEntry.keys, ['foo', 'bar', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
});

test('upsertLore: a too-short key is dropped; a too-long one is clamped to 40 chars, not dropped', () => {
  const result = upsert([], [{ title: 'X', keys: ['a', 'ok', 'x'.repeat(41)], text: 'text' }], {
    source: 'analyzer',
    now: NOW,
  });
  const firstEntry = result.entries[0];
  assert.deepEqual(firstEntry.keys, ['ok', 'x'.repeat(40)]);
});

test('upsertLore: rejects an entry with no valid key', () => {
  const result = upsert([], [{ title: 'X', keys: ['a'], text: 'text' }], { source: 'analyzer', now: NOW });
  assert.equal(result.upserted, 0);
  assert.equal(result.entries.length, 0);
});

// A lore title and text are kept whole, whatever their length.
test('upsertLore: a long title and a long text are kept whole', () => {
  const result = upsert([], [{ title: 'T'.repeat(200), keys: ['valid'], text: 'x'.repeat(1000) }], {
    source: 'analyzer',
    now: NOW,
  });
  const firstEntry = result.entries[0];
  assert.equal(firstEntry.title, 'T'.repeat(200));
  assert.equal(firstEntry.text, 'x'.repeat(1000));
});

test('upsertLore: garbage incoming entries are skipped, never throw', () => {
  const result = upsert([], [null, 'garbage', { title: 'ok', keys: ['ok-key'], text: 'ok text' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.upserted, 1);
  assert.equal(result.entries.length, 1);
});

// ---- eviction: never owner/always, the stalest analyzer entry first ---------

test('upsertLore: evicts the oldest analyzer entry once over maxEntries', () => {
  const existing = [
    entry({ id: 'a', title: 'A', createdAt: '2026-01-01T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const result = upsert(wrongly(existing), [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
    source: 'analyzer',
    now: NOW,
    maxEntries: 2,
  });
  assert.deepEqual(
    result.entries.map((e) => e.title),
    ['B', 'C']
  );
});

test('upsertLore: never evicts an owner entry, even if it is the oldest', () => {
  const existing = [
    entry({ id: 'a', title: 'A', source: 'owner', createdAt: '2020-01-01T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const result = upsert(wrongly(existing), [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
    source: 'analyzer',
    now: NOW,
    maxEntries: 2,
  });
  assert.deepEqual(
    result.entries.map((e) => e.title),
    ['A', 'C']
  );
});

test('upsertLore: never evicts an entry marked always, even an analyzer one', () => {
  const existing = [
    entry({ id: 'a', title: 'A', always: true, createdAt: '2020-01-01T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const result = upsert(wrongly(existing), [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
    source: 'analyzer',
    now: NOW,
    maxEntries: 2,
  });
  assert.deepEqual(
    result.entries.map((e) => e.title),
    ['A', 'C']
  );
});

test('upsertLore: the entry created first and updated last survives the overflow', () => {
  const existing = [
    entry({
      id: 'a',
      title: 'Η πλημμύρα',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    }),
    entry({
      id: 'b',
      title: 'Το πανηγύρι',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    entry({
      id: 'c',
      title: 'Ο σεισμός',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
  ];
  const incoming = [{ title: 'Το καφενείο', keys: ['καφενείο'], text: 'Άνοιξε ξανά.' }];

  const one = upsert(wrongly(existing), incoming, { source: 'analyzer', now: NOW, maxEntries: 3 });
  assert.deepEqual(
    one.entries.map((e) => e.title),
    ['Η πλημμύρα', 'Ο σεισμός', 'Το καφενείο'],
    'the stalest goes, not the first created'
  );
  const two = upsert(wrongly(existing), incoming, { source: 'analyzer', now: NOW, maxEntries: 2 });
  assert.deepEqual(
    two.entries.map((e) => e.title),
    ['Η πλημμύρα', 'Το καφενείο'],
    'then the next stalest'
  );
});

test('upsertLore: an entry the same batch rewrote is not the one evicted', () => {
  const existing = [
    entry({ id: 'a', title: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const result = upsert(
    wrongly(existing),
    [
      { title: 'A', keys: ['a-key'], text: 'a new text' },
      { title: 'C', keys: ['c-key'], text: 'c text' },
    ],
    { source: 'analyzer', now: NOW, maxEntries: 2 }
  );
  assert.deepEqual(
    result.entries.map((e) => [e.title, e.text]),
    [
      ['A', 'a new text'],
      ['C', 'c text'],
    ]
  );
  assert.equal(result.upserted, 2);
});

test('upsertLore: an entry without updatedAt is aged by its createdAt', () => {
  const stamped = entry({
    id: 'b',
    title: 'B',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const evictedOf = (createdAt: Untyped, updatedAt: Untyped) => {
    const bare = entry({ id: 'a', title: 'A', createdAt, updatedAt });
    const result = upsert([bare, stamped], [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
      source: 'analyzer',
      now: NOW,
      maxEntries: 2,
    });
    return ['A', 'B'].filter((title) => !result.entries.some((e) => e.title === title));
  };

  assert.deepEqual(evictedOf('2026-03-01T00:00:00.000Z', undefined), ['B'], 'created after the other was last updated');
  assert.deepEqual(evictedOf('2026-01-15T00:00:00.000Z', null), ['A'], 'created before the other was last updated');
  assert.deepEqual(evictedOf('2026-01-15T00:00:00.000Z', ''), ['A'], 'an empty stamp is no stamp');
});
