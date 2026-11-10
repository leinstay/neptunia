// The store's GIF library (src/memory/store-gifs.ts): a change writes the entries it changed as rows through the writer's
// `gif-library` kind, never the whole library and never a unit, and a new store on the same database reads the library
// back. Synthetic GIF messages over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import type { Row } from '../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const PLACE = 'discord:channel:c1';
const T0 = Date.parse('2026-11-10T10:00:00Z');

const gifMessage = (id: string, n: number, ts = T0) => ({
  id,
  placeId: PLACE,
  ts,
  attachments: [],
  links: [{ id: `${id}#e0`, kind: 'gif', site: 'Tenor', title: '', text: '', url: `https://tenor.com/view/cat-${n}` }],
});

type Sent = { kind: string; write: Row };

/** The service with its library and unit writes recorded in `sent`, each still written. */
function recorded(memoryDb: Row, sent: Array<Sent>): Row {
  const library = memoryDb.writeGifLibrary as ((write: Row) => Promise<unknown>) | undefined;
  const unit = memoryDb.writeUnit as (update: Row) => Promise<unknown>;
  return {
    ...memoryDb,
    writeGifLibrary: (write: Row) => {
      sent.push({ kind: 'gif-library', write });
      return library ? library(write) : Promise.reject(new Error('no gif-library kind'));
    },
    writeUnit: (update: Row) => {
      sent.push({ kind: 'unit', write: update });
      return unit(update);
    },
  };
}

test('a library written through the store is read back whole by a new store on the same database', async () => {
  const dataDir = tempDataDir('nep-gifs-reopen-');
  const first = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.recordGifs(PLACE, [gifMessage('m1', 1), gifMessage('m2', 2)]);
    const [key] = Object.keys(store.getGifs().entries);
    store.setGifFile(key, { hash: 'h1', file: 'media/gifs/h1.gif' });
    store.recordOwnGif(PLACE, 'h1', T0 + 5);
    store.setGifBackfill(PLACE, { at: '2026-11-10T09:00:00Z', channels: 1, messages: 3 });
    written = structuredClone(store.getGifs());
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getGifs();
    assert.deepEqual(read, written);
    assert.equal(store.findGif('g1')?.key, 'h1');
  } finally {
    await second.close();
  }
});

test('a change sends only the entries it changed, through the library kind and never as a unit', async () => {
  const opened = await openTestMemory({ now: () => T0, iface: () => 'discord' });
  try {
    const sent: Array<Sent> = [];
    const memoryDb = recorded(opened.memoryDb, sent);
    const store = createStore({ dataDir: opened.dataDir, memoryDb: memoryDb });
    store.recordGifs(PLACE, [gifMessage('m1', 1), gifMessage('m2', 2), gifMessage('m3', 3)]);
    await store.flushSettled({});
    const keys = Object.keys(store.getGifs().entries);
    sent.length = 0;
    store.recordOwnGif(PLACE, keys[1], T0 + 10);
    await store.flushSettled({});
    assert.deepEqual(
      sent.map((one) => one.kind),
      ['gif-library']
    );
    const write = sent[0].write as { put?: Row; drop?: Array<string> };
    assert.deepEqual(Object.keys(write.put ?? {}), [keys[1]]);
    assert.deepEqual(write.drop ?? [], []);
  } finally {
    await opened.close();
  }
});

test('an entry the library lets go past its size is dropped, and a new store no longer reads it', async () => {
  const dataDir = tempDataDir('nep-gifs-cap-');
  const first = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  let kept: Array<string> = [];
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.recordGifs(PLACE, [gifMessage('m1', 1, T0 - 1000), gifMessage('m2', 2)], { storeMax: 2 });
    await store.flushSettled({});
    store.recordGifs(PLACE, [gifMessage('m3', 3), gifMessage('m4', 2)], { storeMax: 2 });
    kept = Object.keys(store.getGifs().entries);
    assert.equal(kept.length, 2);
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual(Object.keys(store.getGifs().entries).sort(), [...kept].sort());
  } finally {
    await second.close();
  }
});

test('a write the database refused is sent again by the next flush', async () => {
  const dataDir = tempDataDir('nep-gifs-retry-');
  const first = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    let down = true;
    let refused = 0;
    const service = first.memoryDb as unknown as Row;
    const write = service.writeGifLibrary as ((given: Row) => Promise<unknown>) | undefined;
    const memoryDb = {
      ...service,
      writeGifLibrary: (given: Row) => {
        if (!down && write) return write(given);
        refused += 1;
        return Promise.reject(Object.assign(new Error('down'), { code: 'DB_CLOSED' }));
      },
    };
    const store = createStore({ dataDir, memoryDb: memoryDb });
    store.recordGifs(PLACE, [gifMessage('m1', 1)]);
    await store.flushSettled({});
    assert.ok(refused > 0, 'the change went to the library kind');
    down = false;
    store.flush();
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => T0, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.equal(Object.keys(store.getGifs().entries).length, 1);
  } finally {
    await second.close();
  }
});
