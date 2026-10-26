// Tests for src/memory/lore.js: upsertLore (identity, owner protection, key
// normalization, eviction) and matchLore/keywordMatches (whole-word matching,
// scoring, always entries). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertLore, matchLore, keywordMatches } from '../src/memory/lore.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
// The text limit and tolerance a clamping test relies on, set here instead of leaning on the code's fallbacks.
const CLAMP = { textChars: 600, clampTolerance: 1.25 };

function entry(overrides = {}) {
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
  const result = upsertLore([], [{ title: 'New Event', keys: ['event'], text: 'Something happened.' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.upserted, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(typeof result.entries[0].id, 'string');
  assert.ok(result.entries[0].id.length > 0);
  assert.equal(result.entries[0].source, 'analyzer');
  assert.equal(result.entries[0].createdAt, new Date(NOW).toISOString());
});

test('upsertLore: identity is the case-insensitive, trimmed title', () => {
  const existing = [entry({ title: 'The Great Migration' })];
  const result = upsertLore(existing, [{ title: '  the GREAT migration  ', keys: ['xx'], text: 'updated text' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.entries.length, 1, 'same identity, no duplicate row');
  assert.equal(result.entries[0].text, 'updated text');
});

test('upsertLore: an analyzer update replaces keys/text of an ANALYZER entry wholesale', () => {
  const existing = [entry({ keys: ['old-key'], text: 'old text' })];
  const result = upsertLore(existing, [{ title: 'The Great Migration', keys: ['new-key'], text: 'new text' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.deepEqual(result.entries[0].keys, ['new-key']);
  assert.equal(result.entries[0].text, 'new text');
  assert.equal(result.entries[0].id, 'id1', 'the id survives an update');
});

// ---- owner protection ---------------------------------------------------------

test('upsertLore: an analyzer update never touches an existing OWNER entry', () => {
  const existing = [entry({ source: 'owner', text: 'owner-written text', always: true })];
  const result = upsertLore(
    existing,
    [{ title: 'The Great Migration', keys: ['x'], text: 'analyzer tries to overwrite' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 0);
  assert.equal(result.entries[0].text, 'owner-written text');
  assert.equal(result.entries[0].source, 'owner');
});

test('upsertLore: an owner update overwrites an existing ANALYZER entry and takes ownership', () => {
  const existing = [entry({ source: 'analyzer' })];
  const result = upsertLore(
    existing,
    [{ title: 'The Great Migration', keys: ['owner-key'], text: 'owner text', always: true }],
    {
      source: 'owner',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  assert.equal(result.entries[0].source, 'owner');
  assert.equal(result.entries[0].always, true);
  assert.deepEqual(result.entries[0].keys, ['owner-key']);
});

test('upsertLore: an owner update can overwrite another owner entry (re-editing)', () => {
  const existing = [entry({ source: 'owner', always: true, text: 'first version' })];
  const result = upsertLore(
    existing,
    [{ title: 'The Great Migration', keys: ['xx'], text: 'second version', always: false }],
    {
      source: 'owner',
      now: NOW,
    }
  );
  assert.equal(result.entries[0].text, 'second version');
  assert.equal(result.entries[0].always, false);
});

// ---- a re-send that changes nothing ---------------------------------------------

test('upsertLore: an analyzer re-send identical after normalisation is not stamped and counts 0', () => {
  const existing = [entry()];
  const result = upsertLore(
    existing,
    [{ title: 'The Great Migration', keys: ['  Migration ', 'THE MOVE'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 0);
  assert.deepEqual(result.entries, existing, 'the stored entry, updatedAt included, is left as it was');
});

test('upsertLore: only a first write is clamped; a re-send of the clamped text counts 0 and a rewrite is never cut', () => {
  const clamped = upsertLore([], [{ title: 'X', keys: ['valid'], text: 'x'.repeat(1000) }], {
    ...CLAMP,
    source: 'analyzer',
    now: NOW,
  }).entries;
  assert.equal(clamped[0].text.length, 750, 'the first write is clamped');
  const same = upsertLore(clamped, [{ title: 'X', keys: ['valid'], text: 'x'.repeat(750) }], {
    ...CLAMP,
    source: 'analyzer',
    now: NOW + 60_000,
  });
  assert.equal(same.upserted, 0);
  assert.equal(same.entries[0].updatedAt, new Date(NOW).toISOString());
  // A rewrite over the limit is the caller's to refuse (src/memory/prose.js#acceptProse): stored as given.
  const rewritten = upsertLore(clamped, [{ title: 'X', keys: ['valid'], text: 'x'.repeat(2000) }], {
    ...CLAMP,
    source: 'analyzer',
    now: NOW + 60_000,
  });
  assert.equal(rewritten.upserted, 1);
  assert.equal(rewritten.entries[0].text.length, 2000);
});

test('upsertLore: an analyzer re-send that changes only the keys is stamped and counted', () => {
  const result = upsertLore(
    [entry()],
    [{ title: 'The Great Migration', keys: ['migration'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  assert.deepEqual(result.entries[0].keys, ['migration']);
  assert.equal(result.entries[0].updatedAt, new Date(NOW).toISOString());
});

test('upsertLore: an analyzer re-send that changes only the title casing is stamped and counted', () => {
  const result = upsertLore(
    [entry()],
    [{ title: 'the great migration', keys: ['migration', 'the move'], text: 'The server moved house in spring.' }],
    {
      source: 'analyzer',
      now: NOW,
    }
  );
  assert.equal(result.upserted, 1);
  assert.equal(result.entries[0].title, 'the great migration');
  assert.equal(result.entries[0].updatedAt, new Date(NOW).toISOString());
});

test('upsertLore: an owner re-save of an identical owner entry is still stamped and counted (an explicit save)', () => {
  const existing = [entry({ source: 'owner', always: true })];
  const result = upsertLore(
    existing,
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
  assert.equal(result.entries[0].updatedAt, new Date(NOW).toISOString());
});

// ---- key normalization / rejection ------------------------------------------

test('upsertLore: keys are lowercased, trimmed, de-duplicated, kept 1-8', () => {
  const result = upsertLore(
    [],
    [{ title: 'X', keys: ['  Foo  ', 'foo', 'BAR', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'], text: 'text' }],
    { source: 'analyzer', now: NOW }
  );
  assert.deepEqual(result.entries[0].keys, ['foo', 'bar', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
});

test('upsertLore: a too-short key is dropped; a too-long one is clamped to 40 chars, not dropped', () => {
  const result = upsertLore([], [{ title: 'X', keys: ['a', 'ok', 'x'.repeat(41)], text: 'text' }], {
    source: 'analyzer',
    now: NOW,
  });
  assert.deepEqual(result.entries[0].keys, ['ok', 'x'.repeat(40)]);
});

test('upsertLore: rejects an entry with no valid key', () => {
  const result = upsertLore([], [{ title: 'X', keys: ['a'], text: 'text' }], { source: 'analyzer', now: NOW });
  assert.equal(result.upserted, 0);
  assert.equal(result.entries.length, 0);
});

test('upsertLore: title is a hard identity clamp at 80 chars; text is tolerant (textChars * clampTolerance when it has to cut)', () => {
  const result = upsertLore([], [{ title: 'T'.repeat(200), keys: ['valid'], text: 'x'.repeat(1000) }], {
    ...CLAMP,
    source: 'analyzer',
    now: NOW,
  });
  assert.equal(result.entries[0].title.length, 80);
  assert.equal(result.entries[0].text.length, 750, 'no boundary in a single long word -- hard-cut at 600*1.25');
});

test('upsertLore: textChars is configurable and read at the moment of use', () => {
  const result = upsertLore([], [{ title: 'X', keys: ['valid'], text: 'x'.repeat(1000) }], {
    source: 'analyzer',
    now: NOW,
    textChars: 300,
    clampTolerance: 1.25,
  });
  assert.equal(result.entries[0].text.length, 375, '300 * the tolerance 1.25');
});

test('upsertLore: garbage incoming entries are skipped, never throw', () => {
  const result = upsertLore([], [null, 'garbage', { title: 'ok', keys: ['ok-key'], text: 'ok text' }], {
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
  const result = upsertLore(existing, [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
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
  const result = upsertLore(existing, [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
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
  const result = upsertLore(existing, [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
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

  const one = upsertLore(existing, incoming, { source: 'analyzer', now: NOW, maxEntries: 3 });
  assert.deepEqual(
    one.entries.map((e) => e.title),
    ['Η πλημμύρα', 'Ο σεισμός', 'Το καφενείο'],
    'the stalest goes, not the first created'
  );
  const two = upsertLore(existing, incoming, { source: 'analyzer', now: NOW, maxEntries: 2 });
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
  const result = upsertLore(
    existing,
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
  const evictedOf = (createdAt, updatedAt) => {
    const bare = entry({ id: 'a', title: 'A', createdAt, updatedAt });
    const result = upsertLore([bare, stamped], [{ title: 'C', keys: ['c-key'], text: 'c text' }], {
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

// ---- matchLore / keywordMatches ----------------------------------------------

test('keywordMatches: matches a key as a whole word, not inside a longer word', () => {
  const entries = [entry({ title: 'Cat', keys: ['cat'] })];
  assert.equal(keywordMatches(entries, ['I saw a category today']).length, 0);
  assert.equal(keywordMatches(entries, ['I saw a cat today']).length, 1);
});

test('keywordMatches: is case-insensitive', () => {
  const entries = [entry({ title: 'Cat', keys: ['cat'] })];
  assert.equal(keywordMatches(entries, ['I saw a CAT today']).length, 1);
});

test('keywordMatches: matches a Greek (non-Latin) key as a whole word', () => {
  const entries = [entry({ title: 'Γάτα', keys: ['γάτα'] })];
  assert.equal(keywordMatches(entries, ['χτες είδα μια γάτα στον δρόμο']).length, 1);
  assert.equal(keywordMatches(entries, ['δεν υπάρχει τίποτα εδώ']).length, 0);
});

test('keywordMatches: a phrase key matches as a contiguous whole phrase', () => {
  const entries = [entry({ title: 'The Day', keys: ['the day the market burned'] })];
  assert.equal(keywordMatches(entries, ['everyone remembers the day the market burned down']).length, 1);
  assert.equal(keywordMatches(entries, ['the day was fine, the market was closed and burned trash']).length, 0);
});

test('keywordMatches: scores by distinct keys matched, then most recent match position, then weight', () => {
  const a = entry({ id: 'a', title: 'A', keys: ['alpha', 'beta'], weight: 1 });
  const b = entry({ id: 'b', title: 'B', keys: ['gamma'], weight: 5 });
  const texts = ['nothing here', 'alpha appears', 'gamma appears', 'beta appears'];
  const result = keywordMatches([a, b], texts);
  // 'a' matches 2 distinct keys (alpha, beta) vs 'b' matches 1 (gamma) -> 'a' first.
  assert.deepEqual(
    result.map((e) => e.id),
    ['a', 'b']
  );
});

test('keywordMatches: with equal distinct-key counts, the more recent match wins', () => {
  const a = entry({ id: 'a', title: 'A', keys: ['alpha'], weight: 1 });
  const b = entry({ id: 'b', title: 'B', keys: ['beta'], weight: 1 });
  const texts = ['beta appears here', 'alpha appears here'];
  const result = keywordMatches([a, b], texts);
  assert.deepEqual(
    result.map((e) => e.id),
    ['a', 'b'],
    'alpha matched the more recent (later index) text'
  );
});

test('keywordMatches: with equal distinct-keys and recency, higher weight wins', () => {
  const a = entry({ id: 'a', title: 'A', keys: ['same'], weight: 1 });
  const b = entry({ id: 'b', title: 'B', keys: ['same'], weight: 5 });
  const texts = ['same appears once here'];
  const result = keywordMatches([a, b], texts);
  assert.deepEqual(
    result.map((e) => e.id),
    ['b', 'a']
  );
});

test('keywordMatches: an entry with no matched key is excluded entirely', () => {
  const entries = [entry({ keys: ['unrelated-word'] })];
  assert.deepEqual(keywordMatches(entries, ['completely different text']), []);
});

test('matchLore: always entries come first and do not count against maxMatches', () => {
  const always = entry({ id: 'always1', title: 'Always', always: true, keys: ['unrelated-key'] });
  const matched = entry({ id: 'matched1', title: 'Matched', keys: ['found'] });
  const result = matchLore([always, matched], ['found it here'], { maxMatches: 1 });
  assert.deepEqual(
    result.map((e) => e.id),
    ['always1', 'matched1']
  );
});

test('matchLore: caps the non-always matches at maxMatches, most relevant first', () => {
  const a = entry({ id: 'a', title: 'A', keys: ['one'] });
  const b = entry({ id: 'b', title: 'B', keys: ['two'] });
  const c = entry({ id: 'c', title: 'C', keys: ['three'] });
  const texts = ['one appears', 'two appears', 'three appears'];
  const result = matchLore([a, b, c], texts, { maxMatches: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((e) => e.id),
    ['c', 'b'],
    'most recent matches kept first'
  );
});
