// The stable names of custom emoji and stickers (`media_names`, written through the memory writer's `media-names`
// kind): the store issues `e1`, `e2` for emoji and `s1` for stickers at first sight, keeps a name across a rename on
// the platform, gives another interface's thing with the same platform id a name of its own, and a new store on the
// same database reads every name back. Synthetic ids over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

const kekw = { nativeId: '900', platformName: 'kekw', animated: false };
const dance = { nativeId: '901', platformName: 'dance', animated: true };

/** A store over a fresh test memory, closed after `body`. */
async function withStore(body: (store: ReturnType<typeof createStore>) => Promise<void> | void): Promise<void> {
  const opened = await openTestMemory({ now: () => T0, iface: () => 'discord' });
  try {
    await body(createStore({ dataDir: opened.dataDir, memoryDb: opened.memoryDb }));
  } finally {
    await opened.close();
  }
}

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('issues e1 for the first emoji and e2 for a second id', () =>
  withStore((store) => {
    const named = store.nameMedia('discord', 'emoji', [kekw, dance]);
    assert.deepEqual(
      named.map(({ name, nativeId }) => [name, nativeId]),
      [
        ['e1', '900'],
        ['e2', '901'],
      ]
    );
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('gives the same name to an emoji seen a second time', () =>
  withStore((store) => {
    store.nameMedia('discord', 'emoji', [kekw]);
    const [again] = store.nameMedia('discord', 'emoji', [kekw]);
    assert.equal(again.name, 'e1');
    assert.equal(store.mediaNameOf('e2'), null);
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('keeps e1 and records the new platform name when an id comes back renamed', () =>
  withStore((store) => {
    store.nameMedia('discord', 'emoji', [kekw]);
    const [renamed] = store.nameMedia('discord', 'emoji', [{ ...kekw, platformName: 'kekw_v2' }]);
    assert.equal(renamed.name, 'e1');
    assert.equal(store.mediaNameOf('e1')?.platformName, 'kekw_v2');
    assert.equal(store.mediaNameFor('discord', 'emoji', '900')?.platformName, 'kekw_v2');
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('gives two emoji that share a platform name two names', () =>
  withStore((store) => {
    const named = store.nameMedia('discord', 'emoji', [kekw, { ...dance, platformName: 'kekw' }]);
    assert.deepEqual(
      named.map(({ name }) => name),
      ['e1', 'e2']
    );
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test("gives another interface's emoji with the same platform id a name of its own", () =>
  withStore((store) => {
    store.nameMedia('discord', 'emoji', [kekw]);
    const [other] = store.nameMedia('matrix', 'emoji', [kekw]);
    assert.equal(other.name, 'e2');
    assert.equal(store.mediaNameFor('matrix', 'emoji', '900')?.name, 'e2');
    assert.equal(store.mediaNameFor('discord', 'emoji', '900')?.name, 'e1');
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('numbers stickers apart from emoji, from s1', () =>
  withStore((store) => {
    store.nameMedia('discord', 'emoji', [kekw]);
    const [wave] = store.nameMedia('discord', 'sticker', [{ nativeId: '900', platformName: 'wave', animated: false }]);
    assert.equal(wave.name, 's1');
    assert.equal(store.mediaNameOf('s1')?.kind, 'sticker');
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('keeps whether an emoji is animated with its name', () =>
  withStore((store) => {
    store.nameMedia('discord', 'emoji', [kekw, dance]);
    assert.equal(store.mediaNameOf('e2')?.animated, true);
    assert.equal(store.mediaNameOf('e1')?.animated, false);
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('a name written through the store is read back by a new store on the same database', async () => {
  const dataDir = tempDataDir('nep-media-names-');
  const first = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.nameMedia('discord', 'emoji', [kekw, dance]);
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual(store.mediaNameOf('e2'), {
      name: 'e2',
      kind: 'emoji',
      iface: 'discord',
      nativeId: '901',
      platformName: 'dance',
      animated: true,
    });
    const [next] = store.nameMedia('discord', 'emoji', [{ nativeId: '902', platformName: 'nod', animated: false }]);
    assert.equal(next.name, 'e3');
  } finally {
    await second.close();
  }
});
