// The write kinds `place-lore` (src/memory/db/place-lore.ts), `participation-episodes` (participation-episodes.ts) and
// `recent-lines` (recent-lines.ts): a place's lorebook, the stretches she took part in and the lines she said lately,
// written as their rows directly instead of through the mappers of a unit write, each row naming its writer and the
// place that holds it (place-owner.ts). The first test writes the same values through the unit write and through the
// write kinds over copies of one seeded database and compares every table column by column, the owner columns of the
// unit way taken from version step 49. Then the stamps against that step, the reads without the units, the codes, the
// store over a reopen and the generated lorebooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownPlaceListRows } from '../src/memory/db/place-owner.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import {
  CHANNEL,
  NOW,
  OTHER_ROOT,
  ROOT,
  copyOf,
  seededPlaces,
  tablesOf,
  writeBothWays,
  writeDirect,
} from './fixtures/memory-db/place-writes.ts';
import type { PlaceStep } from './fixtures/memory-db/place-writes.ts';

const lore = (extra: Array<Row> = []): Array<Row> => [
  {
    id: 'harbour-1',
    title: 'The harbour',
    keys: ['harbour', 'λιμάνι'],
    text: 'Where the boats sleep.',
    weight: 2,
    source: 'owner',
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  { title: 'No id', keys: [], text: 'An entry with no id.', source: 'analyzer' },
  ...extra,
];

const episode = (itemId: string, messages: ReadonlyArray<string>): Row => ({
  itemId,
  id: `p-${itemId}`,
  placeId: '200000000000000001',
  startAt: NOW - 60_000,
  lastAt: NOW,
  messages: messages.map((id, i) => ({ id, name: 'Άννα', text: `γραμμή ${i}`, own: i === 0 })),
});

const recent = (lines: ReadonlyArray<Row>): Row => ({ nextId: lines.length + 1, lines });
const line = (id: number, extra: Row = {}): Row => ({
  id,
  placeId: '200000000000000001',
  text: `είπα ${id}`,
  at: NOW - id,
  who: ['Άννα'],
  weight: 1,
  addedAt: '2026-11-09T09:00:00.000Z',
  itemId: `rc-${id}`,
  ...extra,
});

/** Two roots' lorebooks sharing an entry, a participation losing an episode and a link, recent lines that change. */
const STEPS: ReadonlyArray<PlaceStep> = [
  { kind: 'lore', placeId: ROOT, value: lore() },
  { kind: 'lore', placeId: OTHER_ROOT, value: { entries: lore().slice(0, 1) } },
  {
    kind: 'participation',
    placeId: ROOT,
    value: { nextId: 3, episodes: [episode('pt-1', ['m1', 'm2']), episode('pt-2', ['m3'])] },
  },
  { kind: 'recent', placeId: CHANNEL, value: recent([line(1), line(2, { itemId: undefined })]) },
  { kind: 'lore', placeId: ROOT, value: lore().slice(1) },
  { kind: 'participation', placeId: ROOT, value: { nextId: 4, episodes: [episode('pt-1', ['m1'])] } },
  { kind: 'recent', placeId: CHANNEL, value: recent([line(2, { itemId: undefined }), line(3)]) },
  { kind: 'lore', placeId: 'discord:guild:300000000000000009', value: [] },
];

function writeAll(handle: MemoryHandle): void {
  for (const step of STEPS) writeDirect(handle, step);
}

test('lorebooks, a participation and recent lines store the same rows both ways', () => {
  const { unit, direct } = writeBothWays(STEPS);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('the writers stamp every row and link with the owner columns version step 49 derives from its unit', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    const db = dbOf(handle);
    const stamped = tablesOf(db);
    assert.deepEqual(
      db
        .prepare('SELECT DISTINCT writer FROM episode_sources WHERE retired_at IS NULL')
        .all()
        .map((row) => row.writer),
      ['participation']
    );
    for (const table of ['claims', 'episodes', 'episode_sources', 'operational', 'co_owners'])
      db.exec(
        `UPDATE "${table}" SET writer = NULL, holder_id = NULL WHERE writer IN ('lore', 'participation', 'recent')`
      );
    ownPlaceListRows(db);
    assert.equal(tablesOf(db), stamped);
  } finally {
    handle.close();
  }
});

test('the lorebooks, the participation and the recent lines read the same once no unit owns their rows', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    const db = dbOf(handle);
    const read = () => ({
      root: unitValue(db, placeCollection('lore', ROOT)),
      other: unitValue(db, placeCollection('lore', OTHER_ROOT)),
      participation: unitValue(db, placeCollection('participation', ROOT)),
      recent: unitValue(db, placeCollection('recent', CHANNEL)),
    });
    const before = read();
    assert.deepEqual(
      ((before.other as { value?: Array<Row> }).value ?? []).map((entry) => entry.id),
      ['harbour-1']
    );
    for (const table of ['claims', 'episodes', 'episode_sources', 'operational', 'co_owners'])
      db.exec(`UPDATE "${table}" SET owner_key = NULL WHERE writer IN ('lore', 'participation', 'recent')`);
    assert.deepEqual(read(), before);
  } finally {
    handle.close();
  }
});

test('a dropped episode retires its message links and a kept one keeps only the links it still names', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    const live = dbOf(handle)
      .prepare(
        'SELECT episode_id, position FROM episode_sources WHERE retired_at IS NULL ORDER BY episode_id, position'
      )
      .all()
      .map((row) => [row.episode_id, row.position]);
    assert.deepEqual(live, [['pt-1', 0]]);
  } finally {
    handle.close();
  }
});

test('a write of each kind that names no place is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    for (const [kind, code] of [
      ['place-lore', 'PLACE_LORE_PLACE'],
      ['participation-episodes', 'PARTICIPATION_PLACE'],
      ['recent-lines', 'RECENT_LINES_PLACE'],
    ])
      assert.throws(() => applyMemoryWrite(handle, { kind, placeId: '', value: {}, now: NOW }), { code }, kind);
  } finally {
    handle.close();
  }
});

test('the store reads back a lorebook and a participation after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-place-lists-reopen-');
  const place = 'discord:guild:300000000000000005';
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.setLore(place, [{ title: 'The flood', keys: ['flood'], text: 'Το νερό ανέβηκε.' }], {
      source: 'owner',
      now: NOW,
    });
    store.setParticipation(place, { nextId: 2, episodes: [episode('pt-9', ['m9'])] }, { now: NOW });
    store.flush();
    await store.flushSettled({});
    written = { lore: store.getLore(place), participation: store.getParticipation(place) };
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = { lore: store.getLore(place), participation: store.getParticipation(place) };
    assert.equal((read.lore[0] as { text?: unknown }).text, 'Το νερό ανέβηκε.');
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

test('the generated lorebooks with every key path of the live files come back as they were written', () => {
  for (const [index, given] of generated('lore').entries()) {
    const handle = copyOf(seededPlaces());
    try {
      const value = plain(given) as Array<Row>;
      writeDirect(handle, { kind: 'lore', placeId: ROOT, value });
      const read = unitValue(dbOf(handle), placeCollection('lore', ROOT));
      assert.deepEqual(read.found ? read.value : [], value, `generated lore ${index}`);
    } finally {
      handle.close();
    }
  }
});

test('a repeated or missing item id, an empty list and an odd shape come back as they were written', () => {
  const values: ReadonlyArray<PlaceStep> = [
    {
      kind: 'participation',
      placeId: ROOT,
      value: { nextId: 1, episodes: [episode('dup', ['m1']), episode('dup', [])] },
    },
    { kind: 'participation', placeId: ROOT, value: { episodes: 'broken', other: [1] } },
    {
      kind: 'recent',
      placeId: CHANNEL,
      value: recent([line(1, { itemId: undefined }), line(1, { itemId: undefined })]),
    },
    { kind: 'recent', placeId: CHANNEL, value: { lines: [{ placeId: 5, text: 7 }] } },
    { kind: 'recent', placeId: CHANNEL, value: { nextId: 1, lines: [] } },
  ];
  for (const step of values) {
    const handle = copyOf(seededPlaces());
    try {
      writeDirect(handle, step);
      if (step.kind === 'review') continue;
      const read = unitValue(dbOf(handle), placeCollection(step.kind, step.placeId));
      assert.deepEqual(read.found ? read.value : null, plain(step.value), JSON.stringify(step.value));
    } finally {
      handle.close();
    }
  }
});
