// The write kind `selfreflection-entries` (src/memory/db/selfreflection-entries.ts): her dated entries, the message ids
// each was mirrored as and their publications, written as their rows directly instead of through the selfreflection
// mapper of a unit write, each row naming its writer and holder (place-owner.ts). The tests read without the units,
// retire a dropped entry's mirror and publication, refuse an empty write, and read the store over a reopen and an
// append.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { personaKey } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { CHANNEL, NOW, copyOf, seededPlaces } from './fixtures/memory-db/place-writes.ts';

const KEY = personaKey('selfreflection');
const OWNED = ['selfreflection', 'selfreflection_mirrors', 'operational', 'publications', 'co_owners'];

const post = (n: number, extra: Row = {}): Row => ({
  itemId: `sr-${n}`,
  at: NOW - n * 60_000,
  kind: 'day',
  gist: `μια μέρα ${n}`,
  picture: null,
  search: null,
  pictures: 1,
  ...extra,
});

/** One write of a test: a whole value, or one post appended with a cap. */
type Step = { value: Row; destination?: string } | { append: Row; max: number; destination?: string };

const STEPS: ReadonlyArray<Step> = [
  {
    value: {
      updatedAt: NOW,
      posts: [
        post(1, { messageIds: ['m1', 'm2'], text: 'Το πλήρες κείμενο.' }),
        post(2, { messageIds: ['m3'], publicationBoundary: { audience: 'owner' } }),
        post(3, { itemId: undefined }),
      ],
    },
    destination: CHANNEL,
  },
  { append: post(4, { messageIds: ['m4'] }), max: 3 },
  { value: { updatedAt: NOW + 1, posts: [post(3, { itemId: undefined }), post(4, { messageIds: ['m4', 'm5'] })] } },
];

function writeDirectWay(handle: MemoryHandle, step: Step): unknown {
  const base = {
    kind: 'selfreflection-entries',
    iface: 'discord',
    now: NOW,
    ...(step.destination ? { destination: step.destination } : {}),
  };
  return 'value' in step
    ? applyMemoryWrite(handle, { ...base, value: step.value })
    : applyMemoryWrite(handle, { ...base, append: step.append, max: step.max, updatedAt: NOW + 2 });
}

const read = (handle: MemoryHandle): unknown => unitValue(dbOf(handle), KEY);

test('the entries read the same once no unit owns their rows', () => {
  const handle = copyOf(seededPlaces());
  try {
    for (const step of STEPS) writeDirectWay(handle, step);
    const before = read(handle);
    const stored = (before as { value?: { posts?: Array<Row> } }).value;
    assert.deepEqual(
      (stored?.posts ?? []).map((entry) => entry.messageIds ?? null),
      [null, ['m4', 'm5']]
    );
    for (const table of OWNED)
      dbOf(handle).exec(`UPDATE "${table}" SET owner_key = NULL WHERE writer = 'selfreflection'`);
    assert.deepEqual(read(handle), before);
  } finally {
    handle.close();
  }
});

test("a dropped entry retires its mirror and its mirror's publication", () => {
  const handle = copyOf(seededPlaces());
  try {
    for (const step of STEPS) writeDirectWay(handle, step);
    const live = dbOf(handle)
      .prepare(
        "SELECT row_id FROM publications WHERE row_kind = 'selfreflection' AND retired_at IS NULL ORDER BY row_id"
      )
      .all()
      .map((row) => row.row_id);
    assert.deepEqual(live, ['sr-4']);
  } finally {
    handle.close();
  }
});

test('a selfreflection write with neither a value nor a post is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    assert.throws(() => applyMemoryWrite(handle, { kind: 'selfreflection-entries', now: NOW }), {
      code: 'SELFREFLECTION_VALUE',
    });
  } finally {
    handle.close();
  }
});

test('the store reads back an appended entry after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-selfreflection-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    // @ts-expect-error a post without a picture is null, the shape the diary writes before one is drawn
    store.appendSelfreflectionPost({ ...post(7), messageIds: [], search: null }, { max: 10, now: NOW });
    await store.flushSettled({});
    written = store.getSelfreflection();
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const back = store.getSelfreflection() as { posts?: Array<{ gist?: unknown }> };
    const [first] = back.posts ?? [];
    assert.equal(first?.gist, 'μια μέρα 7');
    assert.deepEqual(back, written);
  } finally {
    await second.close();
  }
});

test('empty, absent and odd message ids, an empty list and repeated ids come back as they were written', () => {
  const values: ReadonlyArray<Row> = [
    {
      updatedAt: NOW,
      posts: [post(1, { messageIds: [1, 'x'] }), post(2, { messageIds: [], search: 'moths' }), post(3)],
    },
    { posts: [] },
    { posts: [{ gist: 5 }, { itemId: 'same' }, { itemId: 'same' }] },
    { posts: 'broken', other: [1] },
  ];
  for (const value of values) {
    const handle = copyOf(seededPlaces());
    try {
      applyMemoryWrite(handle, { kind: 'selfreflection-entries', value, iface: 'discord', now: NOW });
      const back = read(handle) as { value?: unknown };
      assert.deepEqual(back.value, JSON.parse(JSON.stringify(value)), JSON.stringify(value));
    } finally {
      handle.close();
    }
  }
});
