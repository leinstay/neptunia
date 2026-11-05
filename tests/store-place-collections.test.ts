// The store's public readers, addressed by a canonical place id: the place's notes, its lore, its GIF library, its media
// cache, its recent lines and its participation. The id goes into the key as given, so a server, a channel, a group and a
// thread of any platform shape are all the same call, and two platforms with equal native ids never meet.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getPlace(placeId), store.updatePlace(placeId, fields, opts?)
//   store.getLore(placeId), store.setLore(placeId, incoming, opts)
//   store.getMediaCache(placeId), store.getRecent(placeId), store.getParticipation(placeId)
//   store.listChildren(placeId): the stored child places of a place, one level of `places.parent_id` down
//   store.rootPlaceOf(placeId): the top of its tree, the place itself when it has no parent, null for an unknown id
// A function takes `placeId` alone: there is no `guildId` and no `rootPlaceId` argument. A whole-server operation passes
// the server's own id, and code that needs the top of a tree asks `rootPlaceOf`.
// Appendix entries: src/memory/store.ts (public collections), src/memory/lore.ts, src/memory/recent.ts,
// src/memory/participation.ts, src/memory/gifs.ts, src/turn/request/server.ts, src/behavior/prompt.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addGroupPlace, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

type Store = ReturnType<typeof createStore>;
const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

const A = 'place:room-1';
const B = 'place:room-2';
const LORE_OPTIONS = {
  source: 'owner',
  by: 'owner',
  now: 1000,
  maxEntries: 10,
  textChars: 400,
  clampTolerance: 0,
};
const loreEntry = (title: string) => ({ title, keys: ['synthetic'], text: `about ${title}`, always: false });

function rig(): { store: Store; read: () => Db; write: (body: (db: Db) => void) => void } {
  const dataDir = tempDir('nep-store-places-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addGroupPlace(dbOf(seed), B, 'telegram', 'telegram/global');
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'somewhere-else',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const file = path.join(dataDir, 'memory.db');
  return {
    store,
    read: () => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle())),
    // Rows the writer did not make, over a plain connection because the service holds the writer's lock.
    write: (body) => {
      const connection = new DatabaseSync(file);
      try {
        body(wrongly<Db>(connection));
      } finally {
        connection.close();
      }
    },
  };
}

const save = async (store: Store): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};
const titles = (entries: ReadonlyArray<object>): Array<unknown> =>
  entries.map((one): unknown => Reflect.get(one, 'title'));

test('lore belongs to the place it was written for, under the id as given', async () => {
  // Bug: `communityKey` wraps the id in `<iface>:guild:`, and the catalog holds a place nobody can look up.
  const { store, read } = rig();
  store.setLore(A, [loreEntry('of room one')], LORE_OPTIONS);
  await save(store);
  const [unit] = listUnits(read(), { kind: 'lore' });
  assert.deepEqual(unit?.key.subject, { type: 'place', id: A });
  assert.equal(unit?.key.scopePlaceId, undefined);
});

test('two places read two sets of lore whatever interface is ambient', async () => {
  // Bug: the ambient interface picks the collection, so an event on one interface reads the other's lore.
  const { store } = rig();
  store.setLore(A, [loreEntry('of room one')], LORE_OPTIONS);
  store.setLore(B, [loreEntry('of room two')], LORE_OPTIONS);
  await save(store);
  assert.deepEqual(titles(store.getLore(A)), ['of room one']);
  assert.deepEqual(titles(withIface('telegram', () => store.getLore(A))), ['of room one']);
  assert.deepEqual(titles(withIface('discord', () => store.getLore(B))), ['of room two']);
});

test('the notes of a place are read and written by its id', async () => {
  // Bug: `getGuild` and `updateGuild` remain the only way to the notes, so a Telegram group has none.
  const { store, read } = rig();
  store.updatePlace(A, { patterns: 'short lines at night' });
  await save(store);
  assert.equal(Reflect.get(store.getPlace(A), 'patterns'), 'short lines at night');
  assert.deepEqual(listUnits(read(), { kind: 'guild' }), []);
  assert.equal(Reflect.get(store.getPlace(B), 'patterns'), '');
});

test('a place with nothing stored answers empty and writes no collection', () => {
  // Bug: a read of an empty place fabricates a unit, and the browser lists places nobody wrote about.
  const { store, read } = rig();
  assert.deepEqual(store.getLore(A), []);
  assert.deepEqual(store.getGifs().entries, {});
  assert.deepEqual(store.getRecent(A).lines, []);
  assert.deepEqual(store.getParticipation(A).episodes, []);
  store.flush();
  const kinds = listUnits(read())
    .map((unit) => unit.key.kind)
    .filter((kind) => ['lore', 'gifs', 'recent', 'participation'].includes(kind));
  assert.deepEqual(kinds, []);
});

test('an unnamed place is refused rather than stored under an empty id', () => {
  // Bug: `one:guild:` holds whatever a caller without a place wrote, shared by every such caller.
  const { store } = rig();
  assert.throws(
    () => store.setLore('', [loreEntry('of nowhere')], LORE_OPTIONS),
    (error: { code?: string }) => error.code === 'BAD_COLLECTION_ID'
  );
});

test('the children of a place come from stored parents at any depth, for any place kind', () => {
  // Bug: a fixed list of container kinds stops at the channel, so a thread under a category under a server is lost.
  const { store, write } = rig();
  write((db) => {
    addGroupPlace(db, 'place:server', 'discord', 'discord/global');
    addGroupPlace(db, 'place:category', 'discord', 'discord/global');
    addGroupPlace(db, 'place:channel', 'discord', 'discord/global');
    addGroupPlace(db, 'place:thread', 'discord', 'discord/global');
    db.prepare("UPDATE places SET parent_id = 'place:server' WHERE id = 'place:category'").run();
    db.prepare("UPDATE places SET parent_id = 'place:category' WHERE id = 'place:channel'").run();
    db.prepare("UPDATE places SET parent_id = 'place:channel' WHERE id = 'place:thread'").run();
  });
  const idsOf = (parent: string): Array<unknown> => store.listChildren(parent).map((one) => Reflect.get(one, 'id'));
  assert.deepEqual(idsOf('place:server'), ['place:category']);
  assert.deepEqual(idsOf('place:channel'), ['place:thread']);
  assert.deepEqual(idsOf('place:thread'), []);
});

test('the root of a place is the top of its stored tree at any depth', () => {
  // Bug: a caller passes a separate community id beside the place, and the two disagree after a move.
  const { store, write } = rig();
  write((db) => {
    addGroupPlace(db, 'place:server', 'discord', 'discord/global');
    addGroupPlace(db, 'place:category', 'discord', 'discord/global');
    addGroupPlace(db, 'place:thread', 'discord', 'discord/global');
    db.prepare("UPDATE places SET parent_id = 'place:server' WHERE id = 'place:category'").run();
    db.prepare("UPDATE places SET parent_id = 'place:category' WHERE id = 'place:thread'").run();
  });
  assert.equal(store.rootPlaceOf('place:thread'), 'place:server');
  assert.equal(store.rootPlaceOf('place:server'), 'place:server');
});

test('a DM is its own root and an unknown place has none', () => {
  // Bug: the root falls back to a home server, the old fallback under a new name.
  const { store } = rig();
  assert.equal(store.rootPlaceOf('place:dm-a11'), 'place:dm-a11');
  assert.equal(store.rootPlaceOf('place:never-seen'), null);
});

test('a parent that is missing ends the walk at the last stored place, and a cycle answers none', () => {
  // Bug: an orphaned channel throws in the middle of a turn, or a cycle hangs it.
  const { store, write } = rig();
  write((db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    addGroupPlace(db, 'place:orphan', 'discord', 'discord/global');
    addGroupPlace(db, 'place:loop-a', 'discord', 'discord/global');
    addGroupPlace(db, 'place:loop-b', 'discord', 'discord/global');
    db.prepare("UPDATE places SET parent_id = 'place:gone' WHERE id = 'place:orphan'").run();
    db.prepare("UPDATE places SET parent_id = 'place:loop-b' WHERE id = 'place:loop-a'").run();
    db.prepare("UPDATE places SET parent_id = 'place:loop-a' WHERE id = 'place:loop-b'").run();
  });
  assert.equal(store.rootPlaceOf('place:orphan'), 'place:orphan');
  assert.equal(store.rootPlaceOf('place:loop-a'), null);
});
