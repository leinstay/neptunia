// Tests for src/memory/store-addresses.ts over a real database: the way back from a row to its native id reads only
// stored rows and what the addressing named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { createAddressing } from '../../../src/memory/store-addresses.ts';
import { addAccount, addAuthority } from '../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { after } from 'node:test';
import { createMemoryDb, type MemoryDbService } from '../../../src/memory/db/service.ts';
import { createStore } from '../../../src/memory/store.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../src/memory/db/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { addGroupPlace, seedOpaqueWorld } from '../../fixtures/memory-db/opaque-people.ts';

test('the native id of an account or a place comes from its row or from what the store named it from', () => {
  // Bug: a profile or a channel created before its row exists stores a native id parsed out of an id of another shape.
  const dataDir = tempDir('nep-addresses-rows-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(handle);
  addAuthority(db, 'one', 'one/global');
  addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: 'person:opaque' });
  const seam = { db: () => db, run: <TResult>(fn: () => TResult): TResult => fn() };
  const addressing = createAddressing({ memoryDb: { readHandle: () => handle, namespace: () => 'one' }, seam });
  try {
    assert.equal(addressing.nativeOfRow('accounts', 'account:u1'), 'u1');
    assert.equal(addressing.nativeOfRow('accounts', 'one:u7'), null);
    assert.equal(addressing.nativeOfRow('accounts', addressing.methods().accountOf('u8', 'one')), 'u8');
    assert.equal(addressing.nativeOfRow('places', 'one:channel:c7'), null);
    assert.equal(addressing.nativeOfRow('places', addressing.methods().placeOfChat({ id: 'c8' }, 'one')), 'c8');
  } finally {
    handle.close();
  }
});

// The addressing of the store (src/memory/store.ts, built by src/memory/store-addresses.ts) over a real database:
// native ids become the stored rows when there are some, and a spelling the observation would give when there are none
// yet. The way back, from a row to its person or native id, reads only stored rows and what the store named.

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function storeOver(): ReturnType<typeof createStore> {
  const dataDir = tempDir('nep-addresses-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  addAuthority(db, 'one', 'one/global');
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, scope_kind) VALUES ('one:root:g1', 'one', 'server', 'g1', 'root:g1', 'one/global', 1, 'group')"
  ).run();
  addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: 'person:opaque' });
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_key, authority_id, generation, scope_kind, partner_account, partner_person) VALUES ('place:dm-opaque', 'one', 'dm', 'dm:u1', 'one/global', 1, 'dm', 'account:u1', 'person:opaque')"
  ).run();
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'one',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  return createStore({ dataDir, memoryDb });
}

test('a root and an account resolve to their stored rows, under any spelling of the row id', () => {
  // Bug: the core spells a new id for a server a shipped database holds, and the persona forgets the server after the conversion.
  const store = storeOver();
  assert.equal(store.placeOfRoot('g1', 'one'), 'one:root:g1');
  assert.equal(store.accountOf('u1', 'one'), 'account:u1');
  assert.equal(store.personOfAccount('account:u1'), 'person:opaque');
});

test('what no row holds yet gets the spelling the observation gives', () => {
  // Bug: a turn before the first observed line writes under an id no later row answers.
  const store = storeOver();
  assert.equal(store.placeOfRoot('g2', 'one'), 'one:server:g2');
  assert.equal(store.placeOfChat({ id: 'c9' }, 'one'), 'one:channel:c9');
  assert.equal(store.placeOfChat({ kind: 'dm', partnerId: 'u9' }, 'one'), 'one:dm:u9');
  assert.equal(store.accountOf('u9', 'one'), 'one:u9');
});

test('a read of the interface names a root natively and never a DM', () => {
  // Bug: a canonical id reaches the platform, or a DM place asks a root read that has no answer.
  // The expectation for `one:server:g2` was the native id parsed out of the place id. No id is worked out from the text
  // of another: a place no row holds and the store never named answers as given,
  // since a caller that holds a native root id passes it on, and a root the store named answers its native id.
  const store = storeOver();
  assert.equal(store.nativeRootOf('one:root:g1'), 'g1');
  assert.equal(store.nativeRootOf('one:server:g2'), 'one:server:g2');
  assert.equal(store.nativeRootOf('g3'), 'g3');
  assert.equal(store.nativeRootOf(store.placeOfRoot('g2', 'one')), 'g2');
});

test('an account no row links to a person has no person, and the persons spelled from it are gone', () => {
  // Bug: a turn names `person:<account>`, a person no row holds, and a DM context spelled from it opens nobody's DM.
  const store = storeOver();
  assert.equal(store.personOfAccount('one:u9'), null);
  assert.equal(store.personOfAccount(store.accountOf('u9', 'one')), null);
});

test('the chat of a place no row holds is the one the store named it from, else the id as given', () => {
  // Bug: a call to the interface takes a chat id parsed out of a place id that no row and no named chat backs.
  const store = storeOver();
  assert.equal(store.chatOfPlace('one:channel:c7'), 'one:channel:c7');
  assert.equal(store.chatOfPlace('c7'), 'c7');
  assert.equal(store.chatOfPlace(store.placeOfChat({ id: 'c8' }, 'one')), 'c8');
});

test("a place's interface, kind, native id and partner's native id come from its rows, never from its id", () => {
  // Bug: a turn spelled the chat of a place out of its id, which an opaque place id does not hold, and a DM place holds
  // its partner's native id only on the partner's account row.
  const store = storeOver();
  assert.deepEqual(store.placeRefOf('place:dm-opaque'), {
    iface: 'one',
    kind: 'dm',
    nativeId: null,
    partnerNativeId: 'u1',
  });
  assert.deepEqual(store.placeRefOf('one:root:g1'), {
    iface: 'one',
    kind: 'server',
    nativeId: 'g1',
    partnerNativeId: null,
  });
  assert.equal(store.placeRefOf('one:channel:c7'), null);
});

// The store's public readers, addressed by a canonical place id: the place's notes, its lore, its GIF library, its media
// cache, its recent lines and its participation. The id goes into the key as given, so a server, a channel, a group and a
// thread of any platform shape are all the same call, and two platforms with equal native ids never meet.
// Contract:
//   store.getPlace(placeId), store.setEmojiBackfill(placeId, stamp)
//   store.getLore(placeId), store.setLore(placeId, incoming, opts)
//   store.mediaEntry(placeId, key), store.getRecent(placeId), store.getParticipation(placeId)
//   store.listChildren(placeId): the stored child places of a place, one level of `places.parent_id` down
//   store.rootPlaceOf(placeId): the top of its tree, the place itself when it has no parent, null for an unknown id
// A function takes `placeId` alone: there is no `rootId` and no `rootPlaceId` argument. A whole-server operation passes
// the server's own id, and code that needs the top of a tree asks `rootPlaceOf`.
// Appendix entries: src/memory/store.ts (public collections), src/memory/lore.ts, src/memory/recent.ts,
// src/memory/participation.ts, src/memory/gifs.ts, src/turn/request/server.ts, src/behavior/prompt.ts.

type Store = ReturnType<typeof createStore>;
const storePlaceCollectionsOpened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of storePlaceCollectionsOpened) await service.close();
});
const B = 'place:room-2';

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
  storePlaceCollectionsOpened.push(memoryDb);
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
  // Bug: a caller passes a separate root id beside the place, and the two disagree after a move.
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
