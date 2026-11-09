// The write kind `participation-episodes` (src/memory/db/participation-episodes.ts): the stretches of a place's chats
// she took part in, with a link per message. The retirement of links an episode no longer names, the store over a
// reopen and the odd shapes; the rows both ways are compared in tests/memory-db-place-lore.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import {
  NOW,
  ROOT,
  copyOf,
  episode,
  seededPlaces,
  writeDirect,
  writeListSteps,
} from './fixtures/memory-db/place-writes.ts';
import type { PlaceStep } from './fixtures/memory-db/place-writes.ts';

test('a dropped episode retires its message links and a kept one keeps only the links it still names', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeListSteps(handle);
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

test('a repeated or missing item id and an odd shape come back as they were written', () => {
  const values: ReadonlyArray<PlaceStep> = [
    {
      kind: 'participation',
      placeId: ROOT,
      value: { nextId: 1, episodes: [episode('dup', ['m1']), episode('dup', [])] },
    },
    { kind: 'participation', placeId: ROOT, value: { episodes: 'broken', other: [1] } },
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
