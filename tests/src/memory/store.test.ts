import { accountOf, placeOfRoot, placeOfChat } from '../../../src/memory/addresses.ts';
import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Untyped } from '../../../src/tools/types.ts';
import { createStore, operationalJsonPath, writeJsonAtomic } from '../../../src/memory/store.ts';
import type { Store } from '../../../src/memory/store.ts';
import { openTestMemory, unitFile, openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { writeUnitUpdate } from '../../fixtures/memory-db/unit-writes.ts';
import path, { join } from 'node:path';
import { tempDir } from '../../fixtures/tmp.ts';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { start as startCli } from '../../../interfaces/cli/link.ts';
import { startCore } from '../../../src/core.ts';
import { addClient } from '../../../src/setup/clients.ts';
import { createKeyStore } from '../../../src/keys/store.ts';
import { interfaceNamesOf } from '../../../src/memory/db/frame-reads.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { serveAdapter } from '../../../src/protocol/serve.ts';
import { connectSocket } from '../../../src/protocol/wire.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import {
  memoryAt,
  MEMORY_OF,
  memDataDir,
  keyOfRel,
  unitText,
  AGORA_FACTS,
  WRITERS_DAY_MS,
  WRITERS_T0,
  existsRaw,
  fakeArchive,
  readRaw as storeReadRaw,
  settle as storeSettle,
  tmpDataDir as storeTmpDataDir,
  writeLines,
  writeOldChannelFile,
  underTop,
  writeRaw as storeWriteRaw,
  unitOf as storeUnitOf,
} from '../../fixtures/store-kit.ts';
import { placeCollection, accountCollection, personaKey } from '../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import { gifLibraryValue } from '../../../src/memory/db/gif-library.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import type { GifEntry } from '../../../src/memory/gifs.ts';
import { GUILD, MEMBER, readerEnv } from '../../fixtures/memory-db/readers.ts';
import { currentIface, withIface } from '../../../src/memory/db/current-iface.ts';
import { OBSERVATION_VERSION } from '../../../src/memory/db/observe.ts';
import type { Envelope } from '../../../src/memory/db/observe.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { unitSubjects, unitLines } from '../../../src/memory/db/readers/common.ts';
import { archiveEntry } from '../../../src/memory/archive.ts';
import { addAccount, seedOpaqueWorld, addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { emptyRecent, normalizeRecent } from '../../../src/memory/recent.ts';
import { tokenIds } from '../../../src/memory/mentions.ts';
import { HOUR_MS } from '../../../src/time.ts';
import { DatabaseSync } from 'node:sqlite';
import type { AccountProfileWrite } from '../../../src/memory/db/account-profile.ts';
import { legacyStorageKey } from '../../fixtures/memory-db/legacy-paths.ts';
import { PARTICIPATION_DEFAULTS, emptyParticipation, recordOwnLine } from '../../../src/memory/participation.ts';
import { asRecord } from '../../fixtures/records.ts';
import { loreVersionKey } from '../../../src/memory/lore.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.

test('/nep pause: no timer-driven writer (store.flush) writes memory while paused', async () => {
  const mem = await openTestMemory();
  try {
    const writes: Array<Untyped> = [];
    const memoryDb = {
      ...mem.memoryDb,
      writeUnit: (update: Untyped) => {
        writes.push(update.file);
        return writeUnitUpdate(mem.memoryDb, update);
      },
      // A place's notes have their own write kind (src/memory/db/place-notes.ts), so the store's flush reaches it there.
      writePlaceNotes: (notes: Untyped) => {
        writes.push(notes.placeId);
        return mem.memoryDb.writePlaceNotes(notes);
      },
    };
    const realStore = createStore({ dataDir: mem.dataDir, memoryDb });
    const placeId = 'g1';
    realStore.touchUser(accountOf(realStore, 'u1'), 'Alice', 1000);
    realStore.setEmojiBackfill(placeOfRoot(realStore, placeId), {
      at: '2026-10-01T00:00:00.000Z',
      channels: 1,
      messages: 1,
    });
    realStore.flush();
    await realStore.flushSettled({});
    const before = writes.length;
    assert.ok(before > 0, 'the writes before the pause reached the database');

    const { data } = realStore.state;
    data.paused = true;

    // Mirrors index.js's periodic store timer firing once.
    realStore.flush();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(writes.slice(before), [], 'nothing was written while paused');
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

// Tests of the store's write path for the avatar field: src/memory/store.ts#setAvatar writes it only into an existing
// profile, and a hand-broken field is dropped on read. A test database on a temporary directory, no real data/.

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const ROOT = 'g1';

const TMP_ROOT = tempDir('nep-avatars-');
describe('avatars in the store', () => {
  after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

  // ---- the store's write path -------------------------------------------------------------

  test('store.setAvatar: writes the current avatar only into an existing profile, replaces it, normalised on read', async () => {
    const mem = await openTestMemory({ dataDir: fs.mkdtempSync(path.join(TMP_ROOT, 'store-')) });
    const { dataDir, memoryDb } = mem;
    const store = createStore({ dataDir, memoryDb });
    assert.equal(
      store.setAvatar(accountOf(store, 'u1'), { hash: 'h1', text: 'fox', describedAt: null }),
      null,
      'never creates a profile'
    );
    assert.equal(store.getUser(accountOf(store, 'u1')), null);
    store.touchUser(accountOf(store, 'u1'), 'Ελένη', NOW);
    const before = loose(store.getUser(accountOf(store, 'u1'))).updatedAt;
    store.setAvatar(accountOf(store, 'u1'), { hash: 'h1', text: 'a fox', describedAt: '2026-10-15T12:00:00.000Z' });
    store.setAvatar(accountOf(store, 'u1'), { hash: 'h2', text: 'a cat', describedAt: '2026-10-16T12:00:00.000Z' });
    assert.deepEqual(loose(store.getUser(accountOf(store, 'u1'))).avatar, {
      hash: 'h2',
      text: 'a cat',
      describedAt: '2026-10-16T12:00:00.000Z',
    });
    assert.equal(
      loose(store.getUser(accountOf(store, 'u1'))).updatedAt,
      before,
      'the portrait version stamp is untouched'
    );
    store.setAvatar(accountOf(store, 'u1'), { hash: null, default: true });
    assert.deepEqual(loose(store.getUser(accountOf(store, 'u1'))).avatar, { hash: null, default: true });
    store.flush();
    await store.flushSettled({});
    // A hand-broken field is dropped on read; an absent one stays absent.
    const file = `guilds/${ROOT}/users/u1.json`;
    // @ts-expect-error: unitFile is null only for a file that was never written, and the test wrote this one
    const raw = JSON.parse(unitFile(memoryDb, file));
    await writeUnitUpdate(memoryDb, { op: 'value', file, value: { ...raw, avatar: { hash: 'h3' } } });
    const fresh = createStore({ dataDir, memoryDb });
    assert.equal('avatar' in loose(fresh.getUser(accountOf(fresh, 'u1'))), false);
    await mem.close();
  });
});

// The names the command line declares in its hello (`hello.names`) reach the memory when the client connects over the
// core's socket as a principal of kind `cli`, the way `neptunia` does against a core whose interfaces run as units.
// `startCore` over temporary folders, the real `cli` interface package on a real socket and the memory database read
// through a second, read-only connection. Short folders: a Unix socket path is limited to 108 bytes.

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
/** What the hello of `interfaces/cli/link.ts` (`CLI_NAMES`) says, as the memory reads it back. */
const EXPECTED = { name: 'CLI', nouns: {}, dm: 'chat' };

type Rig = { dataDir: string; connect: () => ReturnType<typeof connectSocket>; token: string };

async function withCore(body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ch-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: [] },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  addClient(dataDir, 'cli', { kind: 'cli', iface: null, permissions: [] });
  try {
    await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [],
        llm: { complete: () => Promise.resolve({ text: '<msg>x</msg>', usage: {}, estimated: 1 }) },
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        await body({
          dataDir,
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
        });
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The names the memory holds for `cli`, read until `ready` accepts them or five seconds pass (the write is async). */
async function storedNames(dataDir: string, ready: (found: ReturnType<typeof interfaceNamesOf>) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
    try {
      const found = interfaceNamesOf(handle.db as Parameters<typeof interfaceNamesOf>[0], 'cli');
      if (ready(found) || Date.now() > deadline) return found;
    } finally {
      handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a later hello of the command line without names keeps the stored ones', async () => {
  // Bug: the names are written by a hello that carries them, and a hello without them must not clear what is stored.
  await withCore(async ({ dataDir, connect, token }) => {
    const first = await startCli({ connect, token, print: null });
    await storedNames(dataDir, (one) => one.name !== null);
    await first.stop();
    const adapter = createFakeAdapter({ iface: 'cli', selfId: 'owner' });
    const bare = serveAdapter({
      transport: await connect(),
      hello: {
        iface: 'cli',
        self: { id: 'owner', name: 'owner' },
        root: null,
        capabilities: adapter.capabilities(),
        resume: null,
      },
      token,
      adapter,
      log: QUIET,
    });
    try {
      // A hello needs a moment to be written; the names must still stand after it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const found = await storedNames(dataDir, (one) => one.name !== null);
      assert.deepEqual(found, EXPECTED);
    } finally {
      bare.close();
    }
  });
});

// Tests of the diary file of the store (src/memory/store.ts): its empty default, its cut to the newest posts and its
// round trip through the memory database.

// ---- store: the diary file (data/guilds/<id>/diary.json) ----

function tmpDataDir() {
  return tempDir('nep-diary-');
}

const post = (n: Untyped) => ({
  at: n * 1000,
  kind: 'thought',
  gist: `post ${n}`,
  picture: null,
  messageIds: [`m${n}`],
  search: '',
});

test('store: getDiary returns the empty default', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  assert.deepEqual(store.getDiary(), { posts: [], updatedAt: 0 });
});

test('store: appendDiaryPost keeps the newest max posts and stamps updatedAt', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  for (let n = 1; n <= 4; n += 1) store.appendDiaryPost(post(n), { max: 3, now: 5000 + n });
  const diary = store.getDiary();
  assert.deepEqual(
    diary.posts.map((p) => p.gist),
    ['post 2', 'post 3', 'post 4']
  );
  assert.equal(diary.updatedAt, 5004);
  diary.posts.length = 0; // a copy: changing it changes nothing stored
  assert.equal(store.getDiary().posts.length, 3);
});

test('store: setDiaryPosts replaces the list and keeps the newest max', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.appendDiaryPost(post(1), { max: 10, now: 1 });
  store.setDiaryPosts([post(5), post(6), post(7)], { max: 2, now: 9 });
  const diary = store.getDiary();
  assert.deepEqual(
    diary.posts.map((p) => p.gist),
    ['post 6', 'post 7']
  );
  assert.equal(diary.updatedAt, 9);
});

test('store: diary survives flush and reload', async () => {
  const mem = await openTestMemory({ dataDir: tmpDataDir() });
  const { dataDir: dir, memoryDb } = mem;
  const store = createStore({ dataDir: dir, memoryDb, newId: () => 'one' });
  store.appendDiaryPost({ ...post(1), gist: 'Ελένη at the café' }, { max: 150, now: 42 });
  store.flush();
  await store.flushSettled({});
  assert.ok(unitFile(memoryDb, 'guilds/g1/diary.json'), 'the diary is a unit of the database');
  const again = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(again.getDiary(), {
    posts: [{ ...post(1), gist: 'Ελένη at the café', itemId: 'dy-one' }],
    updatedAt: 42,
  });
  await mem.close();
});

test('store: a malformed diary value reads as the empty default', async () => {
  const mem = await openTestMemory({ dataDir: tmpDataDir() });
  await writeUnitUpdate(mem.memoryDb, { op: 'value', file: 'guilds/g1/diary.json', value: [1, 2] });
  assert.deepEqual(createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb }).getDiary(), {
    posts: [],
    updatedAt: 0,
  });
  await mem.close();
});

// The store side of the custom emoji backfill (src/memory/store.ts): the `emojiBackfill` stamp of a root, read,
// set and persisted. A real store over a test memory database. The run itself is tested beside
// src/memory/emoji-backfill.ts.

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const emojiBackfillLoose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const T0 = Date.UTC(2026, 8, 1);

test('store emojiBackfill: normalised on read, set only through setEmojiBackfill, cleared usage stays cleared', async () => {
  const mem = await openTestMemory();
  try {
    const { dataDir: dir, memoryDb } = mem;
    const store = createStore({ dataDir: dir, memoryDb });
    assert.equal(emojiBackfillLoose(store.getPlace(placeOfRoot(store, 'g1'))).emojiBackfill, null);

    // The notes are written under the place the store names the root by: a unit names its place, never a path.
    await writeUnitUpdate(memoryDb, {
      op: 'value',
      key: placeCollection('place', placeOfRoot(store, 'g2')),
      value: { emojiBackfill: { at: 5, channels: 'x' } },
    });
    assert.equal(emojiBackfillLoose(store.getPlace(placeOfRoot(store, 'g2'))).emojiBackfill, null);

    await writeUnitUpdate(memoryDb, {
      op: 'value',
      key: placeCollection('place', placeOfRoot(store, 'g3')),
      value: { emojiBackfill: { at: '2026-09-30T00:00:00.000Z', channels: 2.7, messages: -1 } },
    });
    assert.deepEqual(emojiBackfillLoose(store.getPlace(placeOfRoot(store, 'g3'))).emojiBackfill, {
      at: '2026-09-30T00:00:00.000Z',
      channels: 2,
      messages: 0,
    });

    store.setEmojiBackfill(placeOfRoot(store, 'g1'), {
      at: '2026-09-30T00:00:00.000Z',
      channels: 3,
      messages: 40,
    });
    store.recordEmojiUsage(placeOfRoot(store, 'g1'), [{ id: 'm', ts: T0, emojis: [{ id: '1', name: 'alpha' }] }]);
    store.clearEmojiUsage(placeOfRoot(store, 'g1'));
    store.flush();
    await store.flushSettled({});
    const stored = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
    assert.deepEqual(emojiBackfillLoose(stored).emojiBackfill, {
      at: '2026-09-30T00:00:00.000Z',
      channels: 3,
      messages: 40,
    });
    assert.deepEqual(emojiBackfillLoose(stored).emojiUsage, {});
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

// The custom emoji usage ranking of src/memory/emoji-usage.ts in use: its storage in
// guild.json (src/memory/store.ts, a memory unit in the database).

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const emojiUsageLoose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const EMOJI_USAGE_T0 = Date.UTC(2026, 8, 1);

function msg(overrides = {}) {
  return {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: 'hi',
    ts: EMOJI_USAGE_T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

/** `fn(store, memoryDb)` over a store on a fresh memory database, closed and removed after. */
async function withStore(fn: Untyped) {
  const mem = await openTestMemory();
  try {
    return await fn(createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb }), mem.memoryDb, mem.dataDir);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
}

// --- storage -----------------------------------------------------------------

// An emoji and a sticker go by a stable name of the engine.
test('store.getPlace: emojiUsage is normalised on read, missing -> {}', async () => {
  await withStore(async (store: Untyped, memoryDb: Untyped) => {
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage, {});
    // The notes are written under the place the store names the root by: a unit names its place, never a path.
    await writeUnitUpdate(memoryDb as { memoryWrite: (update: unknown) => Promise<unknown> }, {
      op: 'value',
      key: placeCollection('place', placeOfRoot(store, 'g2')),
      value: { patterns: 'p', emojiUsage: { 7: { count: 4, last: 9 }, 8: 'junk' } },
    });
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g2')).emojiUsage, { 7: { count: 4, last: 9 } });
    assert.equal(store.getPlace(placeOfRoot(store, 'g2')).patterns, 'p');
  });
});

// An emoji and a sticker go by a stable name of the engine.
test('store.recordEmojiUsage: persists counts across a new store on the same database', async () => {
  await withStore(async (store: Untyped, memoryDb: Untyped, dataDir: Untyped) => {
    const counted = store.recordEmojiUsage(
      placeOfRoot(store, 'g1'),
      [msg({ ts: EMOJI_USAGE_T0, emojis: [{ id: '10', name: 'kappa' }] })],
      {
        storeMax: 200,
      }
    );
    assert.equal(counted, 1);
    store.flush();
    await store.flushSettled({});
    const stored = createStore({ dataDir, memoryDb }).getPlace(placeOfRoot(store, 'g1'));
    assert.deepEqual(emojiUsageLoose(stored).emojiUsage, { 10: { count: 1, last: EMOJI_USAGE_T0 } });
  });
});

// The store side of the GIF library backfill (src/memory/store.ts): the backfill stamp and a recount, persisted.
// A real store over a test memory database. The run itself is tested beside src/memory/gif-backfill.ts.

const GIF_BACKFILL_T0 = Date.UTC(2026, 8, 1);
const TENOR_A = 'https://tenor.com/view/cat-dance-1';

/** The store with the library typed as it is kept: `getGifs` answers entries of the library, not bare objects. */
type GifStore = Omit<Store, 'getGifs'> & {
  getGifs(): {
    nextId: number;
    entries: Record<string, GifEntry>;
    backfill: { at: string; channels: number; messages: number } | null;
    backfills: Record<string, { at: string; channels: number; messages: number }>;
  };
};

test('store setGifBackfill / resetGifCounts: the stamp is normalised and persisted, a reset keeps entries and handles', async () => {
  const { dir: memoryDir } = memDataDir();
  await (async (store: GifStore, dir: string) => {
    store.recordGifs(placeOfRoot(store, 'g1'), [
      { id: 'm', ts: GIF_BACKFILL_T0, placeId: 'c1', links: [{ id: 'm#e0', kind: 'gif', url: TENOR_A }] },
    ]);
    assert.deepEqual(
      store.setGifBackfill(placeOfRoot(store, 'g1'), {
        at: '2026-09-30T00:00:00.000Z',
        channels: 2.7,
        messages: -1,
      }),
      {
        at: '2026-09-30T00:00:00.000Z',
        channels: 2,
        messages: 0,
      }
    );
    assert.equal(store.setGifBackfill(placeOfRoot(store, 'g2'), wrongly({ at: 5 })), null);

    // B7: a counter's place is the channel the message was in, and a reset is of one place.
    store.resetGifCounts('c1');
    store.flush();
    await wrongly<{ flushSettled(options: object): Promise<void> }>(store).flushSettled({});
    // B7: the library is one unit of the persona.
    const found = gifLibraryValue(dbOf(wrongly(MEMORY_OF.get(memoryDir)?.readHandle())));
    const onDisk = (
      found as unknown as { value: { nextId: number; entries: Record<string, GifEntry>; backfill: unknown } }
    ).value;
    assert.deepEqual(Object.keys(onDisk.entries), ['m#e0']);
    const entryItem = onDisk.entries['m#e0'];
    assert.equal(entryItem.id, 'g1');
    assert.equal(entryItem.count, 0);
    assert.equal(entryItem.last, GIF_BACKFILL_T0);
    assert.equal(onDisk.nextId, 2);
    assert.equal(
      wrongly<Untyped>(createStore(memoryAt(dir)).getGifs().entries['m#e0']).id,
      'g1',
      'a reset entry survives a restart'
    );
    assert.deepEqual(onDisk.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
  })(wrongly<GifStore>(createStore(memoryAt(memoryDir))), memoryDir);
});

// The shared GIF library in the store (src/memory/store.ts over memory.db): one unit, not one per place, read with no
// place at all and surviving a new store over the same database. Plan 2026-11-04-cli-and-memory, stage B7.

const A = 'place:room-1';
const B = 'place:room-2';
const GIF_LIBRARY_STORE_T0 = Date.UTC(2026, 10, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';

function linkMessage(id: string, placeId: string) {
  return {
    id,
    placeId,
    ts: GIF_LIBRARY_STORE_T0,
    attachments: [],
    links: [{ id: `${id}#e0`, kind: 'gif', site: 'Tenor', title: '', text: '', url: TENOR }],
  };
}

function rig() {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  return { store, dir, memoryDb };
}

test('two places record into one library, read with no place', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  store.recordGifs(B, [linkMessage('m2', B)]);
  const entries = Object.values(store.getGifs().entries);
  assert.equal(entries.length, 1);
  const { places } = entries[0];
  assert.equal(places[A].count, 1);
  assert.equal(places[B].count, 1);
});

test('a handle finds the same GIF from any place', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  const found = store.findGif('g1');
  assert.ok(found);
  assert.equal(found.url, TENOR);
});

test('an own post is stamped on the place it went to', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  const [key] = Object.keys(store.getGifs().entries);
  assert.equal(store.recordOwnGif(B, key, GIF_LIBRARY_STORE_T0 + 1), true);
  const entryItem = store.getGifs().entries[key];
  const placeItem = entryItem.places[B];
  assert.equal(placeItem.ownLast, GIF_LIBRARY_STORE_T0 + 1);
});

test('the library survives a new store over the same database', async () => {
  const { store, dir, memoryDb } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  store.recordGifs(B, [linkMessage('m2', B)]);
  store.flush();
  await store.flushSettled({});
  const again = createStore({ dataDir: dir, memoryDb });
  const entries = Object.values(again.getGifs().entries);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].places).sort(), [A, B]);
});

test('the emoji rails of a place survive a new store and stay apart from another place', async () => {
  const { store, dir, memoryDb } = rig();
  const rails = { repliesSince: 1, lastUsed: { wave: GIF_LIBRARY_STORE_T0 } };
  store.setEmojiRails(A, rails);
  store.flush();
  await store.flushSettled({});
  const again = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(again.getEmojiRails(A), rails);
  assert.equal(again.getEmojiRails(B), null);
});

// The GIF library of src/memory/gifs.ts in use: its storage
// in gifs.json (src/memory/store.ts), the <gif> tag (src/llm/parse.ts) and the
// poster (src/behavior/turn.js).

const DAY = 86_400_000;
const GIFS_T0 = Date.UTC(2026, 8, 1);
const GIFS_TENOR = 'https://tenor.com/view/cat-dance-123';

function gifLink(id: string, url = GIFS_TENOR, title = 'Chat qui danse') {
  return { id, kind: 'gif', site: 'Tenor', title, text: '', thumbnailUrl: 'https://media.tenor.com/x.png', url };
}

function gifsMsg(overrides = {}) {
  return {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: '',
    ts: GIFS_T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

// --- storage -----------------------------------------------------------------

/** B7: the library of the persona as the database holds it, undefined when it holds none. */
function libraryUnit(memoryDb: Untyped): Untyped {
  const found: Untyped = gifLibraryValue(dbOf(memoryDb.readHandle()));
  const { found: foundValue } = found;
  return foundValue ? found.value : undefined;
}

test('store.recordGifs: persists its unit; getGifs/findGif read it back after a restart', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  assert.deepEqual(store.getGifs(), { nextId: 1, entries: {}, backfill: null, backfills: {} });
  assert.equal(store.recordGifs(g1, [gifsMsg({ self: true, links: [gifLink('m1#e0')] })], { storeMax: 300 }), 0);
  store.flush();
  await store.flushSettled({});
  assert.equal(libraryUnit(memoryDb), undefined, 'nothing counted, nothing written');

  assert.equal(store.recordGifs(g1, [gifsMsg({ links: [gifLink('m1#e0')] })], { storeMax: 300 }), 1);
  store.flush();
  await store.flushSettled({});
  const onDisk = libraryUnit(memoryDb);
  assert.equal(onDisk.nextId, 2);
  const entryItem = onDisk.entries['m1#e0'];
  assert.equal(entryItem.id, 'g1');

  const reopened = createStore({ dataDir: dir, memoryDb });
  assert.equal(wrongly<Untyped>(present(reopened.findGif('g1'))).url, GIFS_TENOR);
  assert.equal(reopened.findGif('g2'), null);
});

test('store.recordGifs: the fileUrl of an entry reads back after a restart', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  const embed = { ...gifLink('m1#e0'), animationUrl: 'https://media.gifs.example/cat.mp4' };
  store.recordGifs(g1, [gifsMsg({ links: [embed] })], { storeMax: 300 });
  store.flush();
  await store.flushSettled({});
  const reopened = createStore({ dataDir: dir, memoryDb });
  assert.equal(wrongly<Untyped>(present(reopened.findGif('g1'))).fileUrl, 'https://media.gifs.example/cat.mp4');
});

test('store.getGifs: a hand-broken unit is normalised on read, never wiped by reading', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const raw = { entries: { a: { kind: 'link', url: GIFS_TENOR, count: 3, last: GIFS_T0 } } };
  await memoryDb.writeGifLibrary({ put: raw.entries });
  const gifs = store.getGifs();
  assert.equal(wrongly<Record<string, { id: string }>>(gifs.entries).a.id, 'g1');
  assert.equal(gifs.nextId, 2);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(libraryUnit(memoryDb), raw);
});

test('store.recordOwnGif: persists the stamp; an unknown key writes nothing', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  assert.equal(store.recordOwnGif(g1, 'm1#e0', GIFS_T0), false);
  store.flush();
  await store.flushSettled({});
  assert.equal(libraryUnit(memoryDb), undefined, 'nothing marked, nothing written');
  store.recordGifs(g1, [gifsMsg({ links: [gifLink('m1#e0')] })]);
  assert.equal(store.recordOwnGif(g1, 'm1#e0', GIFS_T0 + DAY), true);
  store.flush();
  await store.flushSettled({});
  const entry = createStore({ dataDir: dir, memoryDb }).findGif('g1');
  assert.equal(wrongly<Untyped>(present(entry)).ownLast, GIFS_T0 + DAY);
  assert.equal(wrongly<Untyped>(present(entry)).ownUses, 1);
});

// The seam of the database readers (stage W1): the service's read connection is what the readers read through; the
// store's directory ids and `/nep resume`'s check, and the embedder's catch-up, come from the database with no file
// read.

test('store: the directory ids come from the database only; a closed database is an error with a code', async () => {
  const env = await readerEnv();
  try {
    const originalReaddir = fs.readdirSync;
    let readdirs = 0;
    // The overloads of readdirSync cannot take a forwarded rest, so the wrapper forwards through a loose signature.
    const forward = originalReaddir as (...rest: Array<unknown>) => unknown;
    fs.readdirSync = ((...args: Array<unknown>) => {
      readdirs += 1;
      return forward(...args);
    }) as typeof fs.readdirSync;
    try {
      const store = createStore({ dataDir: env.data, memoryDb: env.memoryDb });
      // The account of the private layer, stored under its spelled id; the same in every guild it writes from.
      assert.deepEqual(
        { private: store.getPrivate(`discord:${MEMBER}`) !== null, users: store.countUsers() },
        { private: true, users: 1 }
      );
      assert.equal(readdirs, 0, 'no directory listed');
    } finally {
      fs.readdirSync = originalReaddir;
    }
    // Root state loads eagerly, so the same closed-database error occurs at construction.
    assert.throws(
      () => createStore({ dataDir: env.data, memoryDb: env.closedDb }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    env.done();
  }
});

test('store: /nep resume checks only the operational JSON files', async () => {
  const env = await readerEnv();
  try {
    const g = path.join(env.data, 'places', GUILD);
    fs.mkdirSync(path.join(g, 'users'), { recursive: true });
    fs.writeFileSync(path.join(g, 'users', '100000000000000077.json'), '{ broken');
    fs.writeFileSync(path.join(g, 'unknown.json'), '{ broken');
    fs.mkdirSync(path.join(g, 'journal', 'requests', '2026-10-21'), { recursive: true });
    fs.writeFileSync(path.join(g, 'journal', 'requests', '2026-10-21', 'turn-9-s1.json'), '{ broken');
    const broken = createStore({ dataDir: env.data, memoryDb: env.memoryDb }).validate().sort();
    // Retired inner state is database-authoritative. The malformed operational request still fails validation.
    assert.deepEqual(broken, [`places/${GUILD}/journal/requests/2026-10-21/turn-9-s1.json`]);
    for (const [rel, kept] of [
      ['state.json', false],
      ['usage.json', false],
      ['vault/x/places/1/users/2.json', true],
      // Changed: no folder of snapshots is written, so its files are no operational ones.
      ['snapshots/a/b.json', false],
      [`places/${GUILD}/gifs.json`, false],
      [`places/${GUILD}/media.json`, false],
      [`places/${GUILD}/participation.json`, false],
      [`places/${GUILD}/backfill/state.json`, true],
      [`places/${GUILD}/record/backfill.json`, true],
      [`places/${GUILD}/private/${MEMBER}/missed.json`, true],
      [`places/${GUILD}/guild.json`, false],
      [`places/${GUILD}/intentions.json`, false],
      [`places/${GUILD}/private/${MEMBER}.json`, false],
      [`places/${GUILD}/record/2026-10/ids.json`, false],
      [`places/${GUILD}/forgotten.json`, false],
    ] as Array<[string, boolean]>)
      assert.equal(operationalJsonPath(rel), kept, rel);
  } finally {
    env.done();
  }
});

// Private lookup by a concrete account, independent of any root and of the ambient interface. Over the real store and
// the real memory service, so a read goes through the same writer and cache a turn does.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getPrivate(accountId: string): object | null
//   store.restoreArchived(placeId: string, entry): the store's write into an existing private layer
// Appendix entries: src/memory/store.ts (private collection), src/memory/db/current-iface.ts, src/memory/db/unit-keys.ts,
// src/memory/root.ts, src/pipeline/private-gate.ts.

type MemoryPrivateIdentityStore = ReturnType<typeof createStore>;
const opened: Array<MemoryDbService> = [];

function memoryPrivateIdentityRig(): { store: MemoryPrivateIdentityStore; memoryDb: MemoryDbService; read: () => Db } {
  const dataDir = tempDir('nep-private-identity-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addAccount(dbOf(seed), {
    id: 'account:other-authority',
    iface: 'discord',
    authority: 'discord/other',
    native: 'n1',
    person: 'person:elsewhere',
  });
  addAccount(dbOf(seed), {
    id: 'account:next-generation',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n1',
    generation: 2,
    person: 'person:later',
  });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    // The home interface a read outside any event falls back to: never the one a test addresses.
    iface: () => currentIface() ?? 'somewhere-else',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  return { store, memoryDb, read };
}

type Details = { details: Array<{ text: string }> };
const detailsOf = (value: object | null): Array<string> =>
  (value as Details | null)?.details.map((one) => one.text) ?? [];

/** The details each test wrote into a private layer, by service and account. */
const written = new WeakMap<MemoryDbService, Map<string, Array<string>>>();

/**
 * A detail appended to the account's private layer, written into the database as the memory session writes it: the
 * layer's whole value, so it replaces what the database held for the account.
 */
async function note(memoryDb: MemoryDbService, account: string, text: string): Promise<void> {
  const byAccount = written.get(memoryDb) ?? new Map<string, Array<string>>();
  written.set(memoryDb, byAccount);
  const texts = [...(byAccount.get(account) ?? []), text];
  byAccount.set(account, texts);
  const details = texts.map((one, i) => ({ id: i + 1, text: one, weight: 1 }));
  await writeUnitUpdate(memoryDb, {
    op: 'value',
    key: accountCollection('private', account),
    value: { details, detailsSeq: details.length + 1 },
  });
}

/** A private detail of `account` put back from the archive: the store writes it into the account's private layer. */
function restoreDetail(store: MemoryPrivateIdentityStore, account: string, text: string): void {
  const entry = archiveEntry(
    { itemId: `dt-${text}`, text, weight: 1 },
    { itemKind: 'detail', event: 'evicted', scope: { user: account, private: true } }
  );
  store.restoreArchived('somewhere', entry);
}

const groupLine = (key: string): Envelope => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key, revision: 0 },
  place: {
    authority: 'discord/global',
    key: 'channel:unrelated',
    kind: 'channel',
    chat: 'group',
    parent: 'server:unrelated',
  },
  author: { kind: 'account', key: 'n1', authority: 'discord/global' },
  occurredAt: '2026-11-02T00:00:00.000Z',
  observedAt: '2026-11-02T00:00:00.000Z',
  text: 'a line in a group nobody asked about',
});
describe('private identity', () => {
  after(async () => {
    for (const service of opened) await service.close();
  });

  test('an account resolves to one private collection before and after an unrelated group is observed', async () => {
    // Bug: the first root the person is seen in becomes the scope, so the DM moves when a group appears.
    const { store, memoryDb, read } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a11', 'keeps a private note');
    const before = unitSubjects(read(), 'private');
    await memoryDb.observe(groupLine('m1'));
    assert.equal(read().prepare("SELECT 1 AS ok FROM places WHERE native_key = 'channel:unrelated'").get()?.ok, 1);
    // The read takes the layer from the database, so the session's claim in the account's DM (seedOpaqueWorld) is in it.
    assert.deepEqual(detailsOf(store.getPrivate('account:a11')), ['keeps a private note', 'the words of claim:a11']);
    await note(memoryDb, 'account:a11', 'and a second one');
    assert.deepEqual(unitSubjects(read(), 'private'), before);
  });

  test('a private collection names its account and no root', async () => {
    // Bug: `rootKey` puts `<iface>:root:<id>` into the key, so two roots split one account's memory.
    const { memoryDb, read } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a21', 'keeps a private note');
    assert.deepEqual(unitSubjects(read(), 'private'), ['account:a21']);
  });

  test('equal native ids in two authorities read two private collections', async () => {
    // Bug: `accountId(namespace, native)` holds no authority, so the second authority reads the first one's secrets.
    const { store, memoryDb } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a11', 'of the first authority');
    assert.equal(store.getPrivate('account:other-authority'), null);
    await note(memoryDb, 'account:other-authority', 'of the second authority');
    // The session's claim in the account's DM (seedOpaqueWorld) is part of its layer.
    assert.deepEqual(detailsOf(store.getPrivate('account:a11')), ['of the first authority', 'the words of claim:a11']);
    assert.deepEqual(detailsOf(store.getPrivate('account:other-authority')), ['of the second authority']);
  });

  test('a later generation of a reused native id reads nothing of the earlier one', async () => {
    // Bug: the new holder of a recycled id inherits a stranger's private memory.
    const { store, memoryDb } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a11', 'of the first generation');
    assert.equal(store.getPrivate('account:next-generation'), null);
  });

  test('the ambient interface does not redirect a read or a write that names its account', async () => {
    // Bug: `namespace()` comes from AsyncLocalStorage, so a read made inside another event addresses another collection.
    const { store, memoryDb } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a21', 'said on the second interface');
    for (const iface of ['telegram', 'discord', 'other']) {
      assert.deepEqual(detailsOf(withIface(iface, () => store.getPrivate('account:a21'))), [
        'said on the second interface',
      ]);
    }
    withIface('discord', () => restoreDetail(store, 'account:a21', 'added from elsewhere'));
    assert.deepEqual(detailsOf(store.getPrivate('account:a21')), [
      'said on the second interface',
      'added from elsewhere',
    ]);
  });

  test('a write begun inside an event lands in its account after the event context ended', async () => {
    // Bug: the flush runs outside `withIface`, so a background retry writes to the home interface's collection.
    const { store, memoryDb, read } = memoryPrivateIdentityRig();
    await note(memoryDb, 'account:a21', 'said before the event');
    withIface('telegram', () => restoreDetail(store, 'account:a21', 'begun in an event'));
    store.flush();
    await store.flushSettled({});
    assert.deepEqual(unitSubjects(read(), 'private'), ['account:a21']);
    assert.deepEqual(detailsOf(store.getPrivate('account:a21')), ['said before the event', 'begun in an event']);
  });

  test('an account nobody stored has no private memory and gets no collection from being asked', () => {
    // Bug: a read of an unknown id fabricates an empty unit, and the owner browser lists a person who never existed.
    const { store, read } = memoryPrivateIdentityRig();
    assert.equal(store.getPrivate('account:never-seen'), null);
    assert.deepEqual(unitSubjects(read(), 'private'), []);
  });
});

// Tests of the store's read path of a recent unit a hand edit broke: the unit is healed on read, by
// src/memory/recent.ts#normalizeRecent, and the broken lines are logged as a count.

const RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const NOW_ISO = new Date(RECENT_NOW).toISOString();
const ELENI = '111111111111111111';
const NIKOS = '222222222222222222';
const AGORA = '900000000000000001';
const KIPOS = '900000000000000002';

/** A stored line as the store holds it. */
function line(id: number, fields: Record<string, unknown> = {}) {
  const text = (fields.text as string | undefined) ?? `γραμμή ${id}`;
  return {
    id,
    at: RECENT_NOW - HOUR_MS,
    addedAt: NOW_ISO,
    placeId: AGORA,
    text,
    who: tokenIds(text),
    weight: 2,
    ...fields,
  };
}

function stored<TLine extends { id: number }>(lines: Array<TLine>, nextId?: number) {
  return { nextId: nextId ?? Math.max(0, ...lines.map((l) => l.id)) + 1, lines };
}

/** The memory database of each data directory made here; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();

/** A temporary data directory with its memory database open: the store's units live there. */
function recentTmpDataDir() {
  const dir = tempDir('nep-recent-');
  MEMORY.set(dir, openTestMemorySync({ dataDir: dir }));
  return dir;
}

const memoryOf = (dir: string) =>
  (MEMORY.get(dir) as { memoryDb: ReturnType<typeof openTestMemorySync>['memoryDb'] }).memoryDb;
const unitOf = (file: string) => [...MEMORY.keys()].find((dir) => file.startsWith(dir + path.sep)) as string;
const relOf = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join('/');

function recentFileOf(dir: string, placeId: string) {
  return path.join(dir, 'guilds', placeId, 'recent.json');
}

/** `value` as the unit `file` stands for, written into its data directory's database (a hand edit). */
function writeRaw(file: string, value: unknown) {
  const dir = unitOf(file);
  return writeUnitUpdate(memoryOf(dir), { op: 'value', key: keyOfRel(relOf(dir, file)), value });
}

/** The unit `file` stands for, as the text of that file, from the database. */
function readRaw(file: string) {
  const dir = unitOf(file);
  return unitText(memoryOf(dir), relOf(dir, file));
}

/** One turn of the event loop: the writes a flush handed to the database have run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
describe('recent lines', () => {
  after(async () => {
    for (const { close } of MEMORY.values()) await close();
  });

  // --- normalizeRecent -------------------------------------------------------------

  test('recent: a hand-edited unit with a broken line is healed on read and not rewritten', async () => {
    const dir = recentTmpDataDir();
    const file = recentFileOf(dir, 'g1');
    writeRaw(file, {
      nextId: 2,
      lines: [
        {
          id: 1,
          at: RECENT_NOW - HOUR_MS,
          addedAt: NOW_ISO,
          placeId: AGORA,
          text: `<@${ELENI}> έφερε γλυκά`,
          who: [NIKOS],
          weight: 9,
        },
        { id: 2, at: 'χθες', placeId: AGORA, text: 'χωρίς ώρα', weight: 2 },
        { id: 3, at: RECENT_NOW, placeId: AGORA, text: '   ', weight: 2 },
        { id: 'τέσσερα', at: RECENT_NOW, placeId: AGORA, text: 'χωρίς αριθμό', weight: 2 },
        { id: 5, at: RECENT_NOW, text: 'χωρίς κανάλι', weight: 2 },
        { id: 7, at: RECENT_NOW, placeId: KIPOS, text: 'κανονική\nσε δύο', weight: 1.5 },
        { id: 7, at: RECENT_NOW, placeId: KIPOS, text: 'ίδιο αριθμό', weight: 0 },
        'σκουπίδι',
      ],
    });
    const raw = readRaw(file);

    const store = createStore({ dataDir: dir, memoryDb: memoryOf(dir) });
    const value = store.getRecent(placeOfRoot(store, 'g1'));
    assert.deepEqual(value, {
      nextId: 9,
      lines: [
        {
          id: 1,
          at: RECENT_NOW - HOUR_MS,
          addedAt: NOW_ISO,
          placeId: AGORA,
          text: `<@${ELENI}> έφερε γλυκά`,
          who: [ELENI],
          weight: 3,
        },
        { id: 7, at: RECENT_NOW, addedAt: null, placeId: KIPOS, text: 'κανονική σε δύο', who: [], weight: 2 },
        { id: 8, at: RECENT_NOW, addedAt: null, placeId: KIPOS, text: 'ίδιο αριθμό', who: [], weight: 1 },
      ],
    });
    store.flush();
    await settle();
    assert.equal(readRaw(file), raw, 'healed in memory, the unit is left as written');

    // pure: garbage reads as empty, a healed value heals to itself
    for (const garbage of [null, 'x', { lines: 'x' }]) assert.deepEqual(normalizeRecent(garbage), emptyRecent());
    assert.deepEqual(normalizeRecent(value), value);
    assert.deepEqual(normalizeRecent({ nextId: 50, lines: [] }), { nextId: 50, lines: [] });

    // a repeated id is healed from the stored nextId on, never with an id a gone line once held
    const healed = normalizeRecent({
      nextId: 50,
      lines: [line(7, { text: 'πρώτη' }), line(7, { text: 'δεύτερη' }), line(7, { text: 'τρίτη' })],
    });
    assert.deepEqual(
      healed.lines.map((l) => [l.id, l.text]),
      [
        [7, 'πρώτη'],
        [50, 'δεύτερη'],
        [51, 'τρίτη'],
      ]
    );
    assert.equal(healed.nextId, 52);
    assert.deepEqual(normalizeRecent(healed), healed);
  });

  test('store: lines a hand edit broke are logged once as a count on load, never by content; a value that is not a store too', async () => {
    const dir = recentTmpDataDir();
    writeRaw(recentFileOf(dir, 'g1'), {
      nextId: 4,
      lines: [
        line(1, { text: 'μένει' }),
        { ...line(2, { text: 'ώρα σε λέξεις' }), at: '2026-10-04T10:00:00Z' },
        { ...line(3, { text: 'χωρίς κανάλι' }), placeId: undefined },
      ],
    });
    writeRaw(recentFileOf(dir, 'g2'), [line(1)]);
    writeRaw(recentFileOf(dir, 'g3'), { nextId: 2, lines: 'καμία' });
    writeRaw(recentFileOf(dir, 'g4'), stored([line(1), line(1, { text: 'ίδιο αριθμό' })]));
    const store = createStore({ dataDir: dir, memoryDb: memoryOf(dir) });

    const { result, logs } = await withCapturedLogs(() => [
      store.getRecent(placeOfRoot(store, 'g1')),
      store.getRecent(placeOfRoot(store, 'g1')),
    ]);
    assert.deepEqual(
      (result[0] as { lines: Array<{ text: string }> }).lines.map((l) => l.text),
      ['μένει']
    );
    const dropped = logs.filter((entry) => entry.msg === 'store: recent lines dropped');
    assert.equal(dropped.length, 1, 'logged on the read that loads the file only');
    assert.equal(dropped[0].level, 'warn');
    assert.equal(dropped[0].placeId, 'discord:server:g1');
    assert.equal(dropped[0].dropped, 2);
    assert.ok(!JSON.stringify(logs).includes('λέξεις') && !JSON.stringify(logs).includes('μένει'), 'counts only');

    const { logs: more } = await withCapturedLogs(() =>
      ['g2', 'g3', 'g4', 'g5'].map((placeId) => store.getRecent(placeOfRoot(store, placeId)))
    );
    assert.deepEqual(
      more
        .filter((entry) => entry.msg.startsWith('store: recent'))
        .map((entry) => [entry.msg, entry.placeId, entry.reason ?? entry.dropped]),
      [
        ['store: recent store replaced', 'discord:server:g2', 'malformed'],
        ['store: recent store replaced', 'discord:server:g3', 'malformed'],
      ],
      'a healed id and a missing file log nothing'
    );
  });
});

// A member's profile through the owner's links (src/memory/store.ts, src/memory/db/account-profile.ts). What describes
// the person is one record behind every account the owner bound: character, details and the affinity score. What
// belongs to one account stays with it: its native id, the names it shows, how it is addressed. Each scenario runs over
// the real memory service on the calling thread, with the links written through its writer.

const IFACE = 'discord';

type StoreLinkedAccountsStore = ReturnType<typeof createStore>;
type StoreLinkedAccountsRig = {
  store: StoreLinkedAccountsStore;
  /** A second store over the same database: what a restart reads. */
  fresh: () => StoreLinkedAccountsStore;
  bind: (native: string, target: { iface: string; native: string }, iface?: string) => Promise<unknown>;
  unbind: (native: string) => Promise<unknown>;
};

const storeLinkedAccountsOpened: Array<MemoryDbService> = [];

const save = async (store: StoreLinkedAccountsStore): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};

/** The person behind account `111`, with a character and a score of 12. The accounts in `known` exist with no profile. */
async function rigOf(
  known: ReadonlyArray<readonly [string, string]> = [[IFACE, '222']]
): Promise<StoreLinkedAccountsRig> {
  const dataDir = tempDir('nep-linked-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const insert = dbOf(seed).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, ?, ?, ?, 'user')"
  );
  for (const [iface, native] of known) insert.run(`${iface}:${native}`, iface, native, native);
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => currentIface() ?? IFACE,
  });
  memoryDb.tick();
  storeLinkedAccountsOpened.push(memoryDb);
  const fresh = (): StoreLinkedAccountsStore => createStore({ dataDir, memoryDb });
  const first = fresh();
  first.touchUser(accountOf(first, '111'), 'Alice', 1000);
  await save(first);
  // The character and the score are the memory session's: written into the database beside what the store keeps.
  // The person and the accounts a read joins in are not stored on the profile.
  const own = { ...(first.getUser(accountOf(first, '111')) as Record<string, unknown>) };
  delete own.personId;
  delete own.accounts;
  await memoryDb.writeAccountProfile({
    accountId: accountOf(first, '111'),
    value: {
      ...own,
      character: 'chatty',
      affinity: {
        score: 12,
        reason: 'nice chat',
        history: [{ ts: new Date(1000).toISOString(), delta: 12, appliedDelta: 12, score: 12, reason: 'nice chat' }],
      },
    },
  });
  // A store started after that write, as the store of a turn after the session.
  const store = fresh();
  return {
    store,
    fresh,
    bind: (native, target, iface = IFACE) =>
      memoryDb.personLink({
        op: 'bind',
        accountId: `${iface}:${native}`,
        target: { accountId: `${target.iface}:${target.native}` },
        now: 2000,
      }),
    unbind: (native) => memoryDb.personLink({ op: 'unbind', accountId: `${IFACE}:${native}`, now: 3000 }),
  };
}

const FIRST = { iface: IFACE, native: '111' };

type Profile = {
  id: string;
  character: string;
  names: Array<string>;
  lastSeen: string;
  addressedAs: Record<string, unknown>;
  affinity: { score: number };
};

/** The profile `store` answers for an account, which must have one. */
function profileOf(store: StoreLinkedAccountsStore, native: string): Profile {
  const found = store.getUser(accountOf(store, native));
  assert.ok(found, `account ${native} reads no profile`);
  return found as Profile;
}

// Profile assembly (plan 2026-11-08-meta-person, slice 7): every account of a person reads the person's accounts.

type Listed = { personId?: string; accounts?: Array<{ iface: string; platformId: string }> };

/** The accounts a profile lists, as `<iface> <platform id>`. */
const listedOf = (profile: unknown): Array<string> =>
  ((profile as Listed | null)?.accounts ?? []).map((account) => `${account.iface} ${account.platformId}`);
describe('linked accounts', () => {
  after(async () => {
    for (const service of storeLinkedAccountsOpened) await service.close();
  });

  test('a linked account with no profile unit reads the profile of its person', async () => {
    // Bug: the read asks for the account's own unit, so a second account of the same person is a stranger to the persona.
    const { store, bind } = await rigOf();
    assert.equal(store.getUser(accountOf(store, '222')), null);
    await bind('222', FIRST);
    const profile = profileOf(store, '222');
    assert.equal(profile.character, 'chatty');
    assert.equal(profile.affinity.score, 12);
    assert.equal(profile.id, 'discord:222');
    assert.ok(!profile.names.includes('Alice'), 'the first account shows its own names');
  });

  test('an account on another interface with an equal native id reads the person only once linked', async () => {
    // Bug: `telegram:111` stays a stranger after the link, or reads `discord:111` before anyone linked them.
    const { store, fresh, bind } = await rigOf([['telegram', '111']]);
    assert.equal(
      withIface('telegram', () => store.getUser(accountOf(store, '111'))),
      null
    );
    await bind('111', FIRST, 'telegram');
    const profile = withIface('telegram', () => profileOf(fresh(), '111'));
    assert.equal(profile.character, 'chatty');
    assert.equal(profile.affinity.score, 12);
  });

  test('a linked account with its own unit reads the person and keeps what is its own', async () => {
    // Bug: the unit's own empty description and zero score hide the person, or the first account's names and address leak.
    const { store, fresh, bind } = await rigOf();
    store.recordAddressUses(accountOf(store, '111'), [{ name: 'Al', at: 1000 }], { now: 1000 });
    store.touchUser(accountOf(store, '222'), 'Bob', 1000);
    store.recordAddressUses(accountOf(store, '222'), [{ name: 'Bobby', at: 1000 }], { now: 1000 });
    await save(store);
    await bind('222', FIRST);
    for (const reader of [store, fresh()]) {
      const second = profileOf(reader, '222');
      assert.equal(second.character, 'chatty');
      assert.equal(second.affinity.score, 12);
      assert.equal(second.id, 'discord:222');
      assert.deepEqual(second.names, ['Bob']);
      // Changed: `addressedAs` is a map by name (src/memory/addressed.ts); this test first read it as a list.
      assert.deepEqual(Object.keys(second.addressedAs), ['Bobby']);
      const first = profileOf(reader, '111');
      assert.deepEqual(first.names, ['Alice']);
      assert.deepEqual(Object.keys(first.addressedAs), ['Al']);
    }
  });

  test('a message from the linked account leaves the profile of the person whole', async () => {
    // Bug: the first line creates an empty unit whose write replaces the person's character and score.
    const { store, fresh, bind } = await rigOf();
    await bind('222', FIRST);
    store.touchUser(accountOf(store, '222'), 'Bob', 2500);
    await save(store);
    const reader = fresh();
    for (const native of ['111', '222']) {
      const profile = profileOf(reader, native);
      assert.equal(profile.character, 'chatty', native);
      assert.equal(profile.affinity.score, 12, native);
    }
    assert.deepEqual(profileOf(reader, '222').names, ['Bob']);
    assert.deepEqual(profileOf(reader, '111').names, ['Alice']);
  });

  test('the decay sweep moves the score of a linked person once', async () => {
    // Bug: the sweep walks both accounts, so a person with two accounts cools twice as fast.
    const { store, fresh, bind } = await rigOf();
    store.touchUser(accountOf(store, '222'), 'Bob', 1000);
    await save(store);
    await bind('222', FIRST);
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse(profileOf(store, '111').lastSeen);
    // The first sweep stamps the score, the second moves it by the days between.
    const sweep = async (one: StoreLinkedAccountsStore): Promise<void> => {
      one.decayAffinities(start + day, { decayPerDay: 1 });
      await save(one);
      one.decayAffinities(start + 8 * day, { decayPerDay: 1 });
      await save(one);
    };
    await sweep(store);

    const control = await rigOf();
    await sweep(control.store);
    const expected = profileOf(control.fresh(), '111').affinity.score;
    assert.ok(expected < 12, 'the sweep decays at all');
    assert.equal(profileOf(fresh(), '111').affinity.score, expected);
    assert.equal(profileOf(fresh(), '222').affinity.score, expected);
  });

  test('an unlink drops the cached read of an account with no unit of its own', async () => {
    // Bug: the store keeps serving the person's profile from its cache to an account the owner just separated.
    const { store, bind, unbind } = await rigOf();
    await bind('222', FIRST);
    assert.equal(profileOf(store, '222').character, 'chatty');
    await unbind('222');
    assert.equal(store.getUser(accountOf(store, '222')), null);
    assert.equal(profileOf(store, '111').character, 'chatty');
  });

  test('after an unlink the account has its own score again and changes reach only it', async () => {
    // Bug: the separated account keeps writing into the person it left, or carries the shared score away.
    const { store, fresh, bind, unbind } = await rigOf();
    store.touchUser(accountOf(store, '222'), 'Bob', 1000);
    await save(store);
    await bind('222', FIRST);
    await unbind('222');
    assert.equal(profileOf(store, '222').affinity.score, 0);
    assert.equal(profileOf(store, '222').character, '');
    // The store's writer of a score left: a line of the separated account is the change that must reach only it.
    store.touchUser(accountOf(store, '222'), 'Bobby', 3500);
    await save(store);
    const reader = fresh();
    assert.deepEqual(profileOf(reader, '222').names, ['Bobby', 'Bob']);
    assert.deepEqual(profileOf(reader, '111').names, ['Alice']);
    assert.equal(profileOf(reader, '111').affinity.score, 12);
    assert.equal(profileOf(reader, '111').character, 'chatty');
  });

  test('both accounts of a person read the same person and list both accounts', async () => {
    // Bug: each account's profile knows only itself, so the persona cannot tell that the two accounts are one person.
    const { store, bind } = await rigOf();
    await bind('222', FIRST);
    const first = store.getUser(accountOf(store, '111')) as Listed | null;
    const second = store.getUser(accountOf(store, '222')) as Listed | null;
    assert.equal(second?.personId, first?.personId);
    assert.deepEqual(listedOf(first), ['discord 111', 'discord 222']);
    assert.deepEqual(listedOf(second), ['discord 111', 'discord 222']);
  });

  test("the owner's profile from the command line lists the Discord account with its platform id", async () => {
    // Bug: from the command line the persona reads only the command line's account and does not know the Discord id.
    const { fresh, bind } = await rigOf([['cli', 'owner']]);
    await bind('owner', FIRST, 'cli');
    const profile = withIface('cli', () => {
      const store = fresh();
      return store.getUser(accountOf(store, 'owner'));
    });
    assert.ok(listedOf(profile).includes('discord 111'), JSON.stringify(listedOf(profile)));
  });
});

// The store's readers of a person's account, addressed by the account node. Over the real store and memory service.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getUser(accountId): StoredRecord | null
//   store.touchUser(accountId, name, at?): StoredRecord
// Appendix entries: src/memory/store.ts (user collection), src/memory/db/storage-context.ts (storage context).

type StoreNeutralReadersStore = ReturnType<typeof createStore>;
const storeNeutralReadersOpened: Array<MemoryDbService> = [];

function storeNeutralReadersRig(): { store: StoreNeutralReadersStore; memoryDb: MemoryDbService; read: () => Db } {
  const dataDir = tempDir('nep-store-neutral-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addAccount(dbOf(seed), {
    id: 'account:free',
    iface: 'matrix',
    authority: 'matrix/global',
    native: 'n5',
    person: null,
  });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'somewhere-else',
  });
  memoryDb.tick();
  storeNeutralReadersOpened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  return { store, memoryDb, read };
}

const storeNeutralReadersSave = async (store: StoreNeutralReadersStore): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};
const namesOf = (profile: unknown): unknown => Reflect.get(Object(profile), 'names');
describe('neutral readers', () => {
  after(async () => {
    for (const service of storeNeutralReadersOpened) await service.close();
  });

  test('a public profile is one collection of its account, whatever root the person spoke in', async () => {
    // Bug: `getUser(rootId, accountId)` keeps one profile per root, so a second root starts a stranger.
    const { store, read } = storeNeutralReadersRig();
    store.touchUser('account:a21', 'Anna', 1000);
    await storeNeutralReadersSave(store);
    assert.deepEqual(namesOf(store.getUser('account:a21')), ['Anna']);
    assert.deepEqual(unitSubjects(read(), 'user'), ['account:a21']);
  });

  test('the ambient interface does not redirect a public profile read', async () => {
    // Bug: a read made inside another interface's event addresses that interface's account with the same native id.
    const { store } = storeNeutralReadersRig();
    store.touchUser('account:a21', 'Anna', 1000);
    await storeNeutralReadersSave(store);
    assert.deepEqual(namesOf(withIface('discord', () => store.getUser('account:a21'))), ['Anna']);
  });

  test('an account nobody knows reads as nothing', () => {
    // Bug: a read of an unknown id creates the empty profile it was meant to find absent, and the gate lets a stranger in.
    const { store } = storeNeutralReadersRig();
    assert.equal(store.getUser('account:never-seen'), null);
  });

  test('a profile read follows a bind and stops at the unbind, with no stale cached person', async () => {
    // Bug: the profile cached before the unbind keeps answering with the linked person's description.
    const { store, memoryDb } = storeNeutralReadersRig();
    store.touchUser('account:a21', 'Anna', 1000);
    store.touchUser('account:free', 'Newcomer', 5000);
    await storeNeutralReadersSave(store);
    const firstSeen = (account: string): unknown => Reflect.get(Object(store.getUser(account)), 'firstSeen');
    const own = firstSeen('account:free');
    assert.notEqual(own, firstSeen('account:a21'));
    await memoryDb.personLink({ op: 'bind', accountId: 'account:free', target: { accountId: 'account:a21' } });
    assert.equal(firstSeen('account:free'), firstSeen('account:a21'));
    assert.deepEqual(namesOf(store.getUser('account:free')), ['Newcomer']);
    await memoryDb.personLink({ op: 'unbind', accountId: 'account:free' });
    assert.equal(firstSeen('account:free'), own);
  });
});

// The store's public readers, addressed by a canonical place id: the place's notes, its lore, its GIF library, its media
// cache, its recent lines and its participation. The id goes into the key as given, so a server, a channel, a group and a
// thread of any platform shape are all the same call, and two platforms with equal native ids never meet.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getPlace(placeId), store.setEmojiBackfill(placeId, stamp)
//   store.getLore(placeId), store.setLore(placeId, incoming, opts)
//   store.mediaEntry(placeId, key), store.getRecent(placeId), store.getParticipation(placeId)
//   store.listChildren(placeId): the stored child places of a place, one level of `places.parent_id` down
//   store.rootPlaceOf(placeId): the top of its tree, the place itself when it has no parent, null for an unknown id
// A function takes `placeId` alone: there is no `rootId` and no `rootPlaceId` argument. A whole-server operation passes
// the server's own id, and code that needs the top of a tree asks `rootPlaceOf`.
// Appendix entries: src/memory/store.ts (public collections), src/memory/lore.ts, src/memory/recent.ts,
// src/memory/participation.ts, src/memory/gifs.ts, src/turn/request/server.ts, src/behavior/prompt.ts.

type StorePlaceCollectionsStore = ReturnType<typeof createStore>;
const storePlaceCollectionsOpened: Array<MemoryDbService> = [];

const STORE_PLACE_COLLECTIONS_A = 'place:room-1';
const STORE_PLACE_COLLECTIONS_B = 'place:room-2';
const LORE_OPTIONS = {
  source: 'owner',
  by: 'owner',
  now: 1000,
  maxEntries: 10,
  textChars: 400,
  clampTolerance: 0,
};
const loreEntry = (title: string) => ({ title, keys: ['synthetic'], text: `about ${title}`, always: false });

function storePlaceCollectionsRig(): {
  store: StorePlaceCollectionsStore;
  read: () => Db;
  write: (body: (db: Db) => void) => void;
} {
  const dataDir = tempDir('nep-store-places-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addGroupPlace(dbOf(seed), STORE_PLACE_COLLECTIONS_B, 'telegram', 'telegram/global');
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

const storePlaceCollectionsSave = async (store: StorePlaceCollectionsStore): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};
const titles = (entries: ReadonlyArray<object>): Array<unknown> =>
  entries.map((one): unknown => Reflect.get(one, 'title'));
describe('collections of a place', () => {
  after(async () => {
    for (const service of storePlaceCollectionsOpened) await service.close();
  });

  test('lore belongs to the place it was written for, under the id as given', async () => {
    // Bug: `rootKey` wraps the id in `<iface>:root:`, and the catalog holds a place nobody can look up.
    const { store, read } = storePlaceCollectionsRig();
    store.setLore(STORE_PLACE_COLLECTIONS_A, [loreEntry('of room one')], LORE_OPTIONS);
    await storePlaceCollectionsSave(store);
    const holders = read().prepare("SELECT DISTINCT holder_id FROM claims WHERE writer = 'lore'").all();
    assert.deepEqual(
      holders.map((row) => row.holder_id),
      [STORE_PLACE_COLLECTIONS_A]
    );
  });

  test('two places read two sets of lore whatever interface is ambient', async () => {
    // Bug: the ambient interface picks the collection, so an event on one interface reads the other's lore.
    const { store } = storePlaceCollectionsRig();
    store.setLore(STORE_PLACE_COLLECTIONS_A, [loreEntry('of room one')], LORE_OPTIONS);
    store.setLore(STORE_PLACE_COLLECTIONS_B, [loreEntry('of room two')], LORE_OPTIONS);
    await storePlaceCollectionsSave(store);
    assert.deepEqual(titles(store.getLore(STORE_PLACE_COLLECTIONS_A)), ['of room one']);
    assert.deepEqual(titles(withIface('telegram', () => store.getLore(STORE_PLACE_COLLECTIONS_A))), ['of room one']);
    assert.deepEqual(titles(withIface('discord', () => store.getLore(STORE_PLACE_COLLECTIONS_B))), ['of room two']);
  });

  test('the notes of a place are read and written by its id', async () => {
    // Bug: `getRoot` and `updateRoot` remain the only way to the notes, so a Telegram group has none.
    const { store } = storePlaceCollectionsRig();
    const stamp = { at: '2026-11-02T09:00:00.000Z', channels: 1, messages: 4 };
    store.setEmojiBackfill(STORE_PLACE_COLLECTIONS_A, stamp);
    await storePlaceCollectionsSave(store);
    assert.deepEqual(Reflect.get(store.getPlace(STORE_PLACE_COLLECTIONS_A), 'emojiBackfill'), stamp);
    assert.equal(Reflect.get(store.getPlace(STORE_PLACE_COLLECTIONS_B), 'emojiBackfill'), null);
  });

  test('a place with nothing stored answers empty and writes no collection', () => {
    // Bug: a read of an empty place fabricates a unit, and the browser lists places nobody wrote about.
    const { store, read } = storePlaceCollectionsRig();
    assert.deepEqual(store.getLore(STORE_PLACE_COLLECTIONS_A), []);
    assert.deepEqual(store.getGifs().entries, {});
    assert.deepEqual(store.getRecent(STORE_PLACE_COLLECTIONS_A).lines, []);
    assert.deepEqual(store.getParticipation(STORE_PLACE_COLLECTIONS_A).episodes, []);
    store.flush();
    const writers = ['claims', 'operational', 'episodes', 'media'].flatMap((table) =>
      read()
        .prepare(`SELECT DISTINCT writer FROM "${table}" WHERE writer IN ('lore', 'gifs', 'recent', 'participation')`)
        .all()
    );
    assert.deepEqual(writers, []);
  });

  test('an unnamed place is refused rather than stored under an empty id', () => {
    // Bug: `one:root:` holds whatever a caller without a place wrote, shared by every such caller.
    const { store } = storePlaceCollectionsRig();
    assert.throws(
      () => store.setLore('', [loreEntry('of nowhere')], LORE_OPTIONS),
      (error: { code?: string }) => error.code === 'BAD_COLLECTION_ID'
    );
  });
});

// Recall diagnostics persist through the memory writer without recreating legacy directories.

test('recall traces keep the newest capped records across database reopen without creating a roots directory', async () => {
  // Bug: database-backed recall traces recreate legacy root files or lose queued records before a flush.
  let mem = await openTestMemory();
  try {
    const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    for (const run of [1, 2, 3]) store.appendRecallTrace(placeOfRoot(store, 'g1'), { run }, { maxLines: 2 });
    await store.flushSettled({});
    const key = placeCollection('recall_trace', placeOfRoot(store, 'g1'));
    const expected = [JSON.stringify({ run: 2 }), JSON.stringify({ run: 3 })];
    assert.deepEqual(unitLines(mem.memoryDb.readHandle()?.db, key), expected);
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    assert.deepEqual(unitLines(mem.memoryDb.readHandle()?.db, key), expected);
    assert.equal(fs.existsSync(path.join(mem.dataDir, 'guilds')), false);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

// Tests for the memory store (src/memory/store.ts): the contract its header states, through its public exports.

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

test('touchUser: puts the current name first, keeps previous names after, deduplicated', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.touchUser(accountOf(store, 'u1'), 'Bob', 2000); // renamed
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 3000); // renamed back
  assert.deepEqual(asRecord(profile).names, ['Alice', 'Bob']); // no duplicate 'Alice'
});

test('touchUser: names list is capped at 5 entries', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  let profile;
  for (const [i, name] of names.entries()) profile = store.touchUser(accountOf(store, 'u1'), name, i);
  assert.equal(asRecord(profile).names.length, 5);
  assert.equal(asRecord(profile).names[0], 'n6'); // most recent first
});

test('touchUser: an empty/falsy name does not touch the names list', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.touchUser(accountOf(store, 'u1'), '', 2000);
  assert.deepEqual(asRecord(profile).names, ['Alice']);
});

// ---- out-of-order touches (old history fed after a live touch today) ----

test('touchUser: firstSeen is min(existing, at) and lastSeen is max(existing, at), regardless of arrival order', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  // Live touch today...
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000);
  // ...then four years of older history arrive.
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  assert.equal(asRecord(profile).firstSeen, new Date(1000).toISOString(), 'firstSeen widens to the older message');
  assert.equal(
    asRecord(profile).lastSeen,
    new Date(5_000_000).toISOString(),
    'lastSeen does NOT regress to the older message'
  );
  assert.equal(asRecord(profile).messageCount, 2);
});

test('touchUser: an older/backdated touch never moves a name to the front', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000); // live, current display name
  const profile = store.touchUser(accountOf(store, 'u1'), 'OldNick', 1000); // backdated history, an older name
  assert.deepEqual(
    asRecord(profile).names,
    ['Alice', 'OldNick'],
    'the current name stays first; the old one is appended'
  );
});

test('touchUser: a backdated touch of an already-known name leaves the names order untouched', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000);
  store.touchUser(accountOf(store, 'u1'), 'Bob', 6_000_000); // renamed, now current
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 1000); // backdated history mentioning the old name
  assert.deepEqual(asRecord(profile).names, ['Bob', 'Alice'], 'Alice is not moved back to the front by an older touch');
});

test('touchUser: a touch at exactly the stored lastSeen still counts as newest (moves the name to the front)', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.touchUser(accountOf(store, 'u1'), 'Bob', 1000);
  assert.deepEqual(asRecord(profile).names, ['Bob', 'Alice']);
});

// ---- guild.learned: things people taught the persona --------------------------

test('getPlace: a hand-edited learned list is validated, ids assigned off learnedNextId', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  storeWriteRaw(file, {
    patterns: '',
    learned: [
      { id: 4, text: 'Café closes at nine', weight: 2, from: '<@322222222222222222>' },
      { text: 'Friday is τυρόπιτα day' },
      'garbage',
      { text: '' },
    ],
    learnedNextId: 3,
  });
  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual(
    asRecord(guild).learned.map((i: Untyped) => [i.id, i.text, i.from]),
    [
      [4, 'Café closes at nine', '<@322222222222222222>'],
      [5, 'Friday is τυρόπιτα day', undefined],
    ]
  );
  assert.equal(asRecord(guild).learnedNextId, 6);
});

test('getPlace: learned that is not an array or a garbage learnedNextId never throws', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  storeWriteRaw(file, { patterns: 'x', learned: 'nope', learnedNextId: -3 });
  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual(asRecord(guild).learned, []);
  assert.equal(asRecord(guild).learnedNextId, 1);
  assert.equal(asRecord(guild).patterns, 'x');
});

// ---- the notes stamps: when the server and channel notes last changed, and were last re-checked ----

test('getPlace: notes stamps a hand edit broke read as never stamped', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  storeWriteRaw(file, { patterns: 'μιμίδια', notesUpdatedAt: 'χθες', notesCheckedAt: 1759654800000 });

  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual([asRecord(guild).notesUpdatedAt, asRecord(guild).notesCheckedAt], [null, null]);
  assert.equal(asRecord(guild).patterns, 'μιμίδια');
});

test('writeJsonAtomic: a refused rename falls back to an in-place write, and says so in the log', async () => {
  const dir = storeTmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted');
    Object.assign(err, { code: 'EPERM' });
    throw err;
  };
  let logs;
  try {
    ({ logs } = await withCapturedLogs(() => writeJsonAtomic(file, { patterns: 'μιμίδια' })));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { patterns: 'μιμίδια' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['guild.json'], 'no temp file left behind');
  const warning = logs.find((entry) => entry.msg === 'store: rename failed, writing in place');
  assert.ok(warning);
  assert.equal(warning.file, file);
  assert.equal(warning.error.code, 'EPERM');
});

test('flush + a new store instance over the same database: profiles and guild memory survive a "restart"; no memory file is written', async () => {
  const mem = await openTestMemory();
  try {
    const storeA = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    storeA.touchUser(accountOf(storeA, 'u1'), 'Alice', 1000);
    storeA.setEmojiBackfill(placeOfRoot(storeA, 'g1'), { at: '2026-10-01T00:00:00.000Z', channels: 2, messages: 9 });
    storeA.flush();
    await storeA.flushSettled({});

    const storeB = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    const profile = storeB.getUser(accountOf(storeB, 'u1'));
    assert.deepEqual(asRecord(profile).names, ['Alice']);
    assert.equal(asRecord(profile).messageCount, 1);
    assert.deepEqual(asRecord(storeB.getPlace(placeOfRoot(storeB, 'g1'))).emojiBackfill, {
      at: '2026-10-01T00:00:00.000Z',
      channels: 2,
      messages: 9,
    });
    assert.equal(
      fs.existsSync(path.join(mem.dataDir, 'guilds', 'g1', 'users', 'u1.json')),
      false,
      'the profile is a database unit'
    );
    assert.equal(fs.existsSync(path.join(mem.dataDir, 'guilds', 'g1', 'guild.json')), false, 'the guild memory too');
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

test('flush: only writes the units that are dirty', async () => {
  const { dir, memoryDb } = memDataDir();
  const writes: Array<Untyped> = [];
  // A profile has its own write kind (account-profile.ts): its write is counted under the key of its unit.
  const counted = {
    ...memoryDb,
    writeAccountProfile: (write: AccountProfileWrite) => {
      writes.push(accountCollection('user', write.accountId));
      return memoryDb.writeAccountProfile(write);
    },
  };
  const store = createStore({ dataDir: dir, memoryDb: counted });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(writes, [legacyStorageKey('guilds/g1/users/u1.json')]);
  store.flush();
  await store.flushSettled({}); // nothing changed since -> should be a no-op
  assert.deepEqual(writes, [legacyStorageKey('guilds/g1/users/u1.json')]);
});

test('state: data persists across restarts via flush + markDirty', async () => {
  const dir = storeTmpDataDir();
  const storeA = createStore(memoryAt(dir));
  const { data } = storeA.state;
  data.llmDay = '2026-09-20';
  data.llmCount = 5;
  storeA.state.markDirty();
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore(memoryAt(dir));
  const { data: dataValue } = storeB.state;
  assert.equal(dataValue.llmDay, '2026-09-20');
  assert.equal(dataValue.llmCount, 5);
});

test('countUsers: counts a profile not flushed yet, like every other lister', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  store.touchUser(accountOf(store, 'u2'), 'Zoé', 1000); // only cached
  assert.equal(store.countUsers(), 2);
  assert.equal(store.countUsers(), store.listUserProfiles().length);
});

// --- channels (the server map) ----------------------------------------------

test('touchChannel: repeated calls the same UTC day increment the same bucket', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 8, 20, 1, 0, 0));
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 8, 20, 23, 0, 0));
  assert.equal(asRecord(channel).messageCount, 2);
  assert.deepEqual(asRecord(channel).days, { '2026-09-20': 2 });
});

test('touchChannel: lastMessageAt keeps the maximum timestamp seen, even out of order', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 5000);
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 1000); // arrives "late", out of order
  assert.equal(asRecord(channel).lastMessageAt, 5000);
});

test('touchChannel: trims the day histogram to the newest 30 dates', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  let channel;
  for (let day = 0; day < 35; day += 1) {
    channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 0, 1 + day, 12, 0, 0));
  }
  const keys = Object.keys(asRecord(channel).days).sort();
  assert.equal(keys.length, 30);
  assert.equal(keys[0], '2026-01-06'); // the oldest 5 days were trimmed
  assert.equal(keys.at(-1), '2026-02-04');
});

test('touchChannel: bumps the author into topWriters and adds up repeated visits', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 1000, 'alice');
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 2000, 'alice');
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 3000, 'bob');
  assert.deepEqual(asRecord(channel).topWriters, [
    { id: 'alice', count: 2 },
    { id: 'bob', count: 1 },
  ]);
});

test('flush + a new store instance: channels survive a "restart"', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.touchChannel(placeOfChat(storeA, { id: 'c1' }), { name: 'general', topic: 'chat' }, 1000, 'άλφα');
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const channel = storeB.getChannel(placeOfChat(storeB, { id: 'c1' }));
  assert.equal(channel?.name, 'general');
  assert.equal(channel?.topic, 'chat');
  assert.deepEqual(channel?.topWriters, [{ id: 'άλφα', count: 1 }]);
  assert.deepEqual(channel?.days, { '1970-01-01': 1 });
});

// ---- the writers tally behind a channel's topWriters ------------------------

test('touchChannel: a newcomer who keeps writing enters topWriters past five stored writers', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  for (const [i, id] of ['άλφα', 'βήτα', 'γάμα', 'δέλτα', 'έψιλον'].entries())
    writeLines(store, 'c1', id, 1, WRITERS_T0 + i);

  const channel = writeLines(store, 'c1', 'ζήτα', 50, WRITERS_T0 + 1000);

  assert.deepEqual(channel.topWriters[0], { id: 'ζήτα', count: 50 });
  assert.deepEqual(
    channel.topWriters.map((writer: Untyped) => writer.id),
    ['ζήτα', 'έψιλον', 'δέλτα', 'γάμα', 'βήτα'],
    'the five shown, the latest of equals first'
  );
  assert.deepEqual(
    channel.writers['άλφα'],
    { count: 1, last: WRITERS_T0 },
    'the writer who left the five shown keeps a tally'
  );
});

test('touchChannel: a writer silent for 90 days falls below a steady newcomer', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const pair = (placeId: string, daysLater: number, opts?: Parameters<typeof writeLines>[5]) => {
    writeLines(store, placeId, 'παλιός', 8, WRITERS_T0, opts);
    return writeLines(store, placeId, 'νέος', 3, WRITERS_T0 + daysLater * WRITERS_DAY_MS, opts).topWriters;
  };

  assert.deepEqual(
    pair('c1', 1),
    [
      { id: 'παλιός', count: 8 },
      { id: 'νέος', count: 3 },
    ],
    'a day apart the count decides'
  );
  assert.deepEqual(
    pair('c2', 90),
    [
      { id: 'νέος', count: 3 },
      { id: 'παλιός', count: 8 },
    ],
    'three half-lives of silence outweigh the count'
  );
  assert.deepEqual(
    store.getChannel(placeOfChat(store, { id: 'c2' }))?.writers['παλιός'],
    { count: 8, last: WRITERS_T0 + 7 },
    'ranked lower, not forgotten'
  );
});

test('touchChannel: channelWritersHalfLifeDays is read from the call; 0 ranks by count alone', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const order = (placeId: string, opts: Parameters<typeof writeLines>[5]) => {
    writeLines(store, placeId, 'παλιός', 8, WRITERS_T0, opts);
    return writeLines(store, placeId, 'νέος', 3, WRITERS_T0 + 90 * WRITERS_DAY_MS, opts).topWriters.map(
      (writer: Untyped) => writer.id
    );
  };

  assert.deepEqual(order('c1', { channelWritersHalfLifeDays: 0 }), ['παλιός', 'νέος']);
  assert.deepEqual(
    order('c2', { channelWritersHalfLifeDays: 365 }),
    ['παλιός', 'νέος'],
    'a quarter of a half-life is not enough'
  );
  assert.deepEqual(order('c3', { channelWritersHalfLifeDays: 30 }), ['νέος', 'παλιός']);
  assert.deepEqual(
    // @ts-expect-error: the test hands a text where a count belongs, as a hand-edited config may
    order('c4', { channelWritersHalfLifeDays: 'μήνας' }),
    ['νέος', 'παλιός'],
    'not a number: the 30 days of config.json'
  );
});

test('touchChannel: the tally keeps channelWritersStored writers, 20 unless told, never fewer than the five shown', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const stored = (placeId: string, opts?: Parameters<typeof writeLines>[5]) => {
    for (let n = 0; n < 25; n += 1)
      writeLines(store, placeId, `γράφων-${String(n).padStart(2, '0')}`, 1, WRITERS_T0 + n, opts);
    return Object.keys(asRecord(store.getChannel(placeOfChat(store, { id: placeId }))).writers as object).sort();
  };
  const newest = (count: number) =>
    Array.from({ length: count }, (_, i) => `γράφων-${String(25 - count + i).padStart(2, '0')}`);

  assert.deepEqual(stored('c1'), newest(20), 'the lowest-ranked leave: here the ones who wrote longest ago');
  assert.deepEqual(stored('c2', { channelWritersStored: 7 }), newest(7));
  assert.deepEqual(stored('c3', { channelWritersStored: 0 }), newest(5));
  // @ts-expect-error: the test hands a text where a count belongs, as a hand-edited config may
  assert.deepEqual(stored('c4', { channelWritersStored: 'πολλοί' }), newest(20), 'not a number: the 20 of config.json');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c2' }))?.topWriters.length, 5);
});

test('touchChannel: a writer below the five shown comes back with the count they gathered', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  for (const id of ['άλφα', 'βήτα', 'γάμα', 'δέλτα', 'έψιλον']) writeLines(store, 'c1', id, 3, WRITERS_T0);
  const below = writeLines(store, 'c1', 'ζήτα', 2, WRITERS_T0);
  assert.ok(
    !below.topWriters.some((writer: Untyped) => writer.id === 'ζήτα'),
    'two lines against five writers with three'
  );

  const channel = writeLines(store, 'c1', 'ζήτα', 2, WRITERS_T0 + 10);
  assert.deepEqual(channel.topWriters[0], { id: 'ζήτα', count: 4 });
});

test("touchChannel: a line that arrives late is counted and never moves the writer's last backwards", () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  writeLines(store, 'c1', 'άλφα', 1, WRITERS_T0 + 5000);
  const channel = writeLines(store, 'c1', 'άλφα', 1, WRITERS_T0);
  assert.deepEqual(channel.writers, { άλφα: { count: 2, last: WRITERS_T0 + 5000 } });
});

test('touchChannel: a message without an author leaves the tally and topWriters as they are', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  writeLines(store, 'c1', 'άλφα', 2, WRITERS_T0);
  const before = structuredClone(store.getChannel(placeOfChat(store, { id: 'c1' })));

  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), AGORA_FACTS, WRITERS_T0 + 10);
  assert.deepEqual([asRecord(channel).writers, asRecord(channel).topWriters], [before?.writers, before?.topWriters]);
  assert.equal(asRecord(channel).messageCount, asRecord(before).messageCount + 1);
});

test('touchChannel: counters never stamp updatedAt or the notes stamps', async () => {
  const { dir, memoryDb } = memDataDir();
  writeOldChannelFile(dir, 'c1', { notesCheckedAt: '2026-06-02T00:00:00.000Z' });
  const store = createStore({ dataDir: dir, memoryDb });
  writeLines(store, 'c1', 'άλφα', 3, WRITERS_T0);
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.updatedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesCheckedAt, '2026-06-02T00:00:00.000Z');
  writeLines(store, 'c2', 'άλφα', 1, WRITERS_T0);
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c2' }))?.updatedAt, null);
});

test('getChannel: a tally or a check stamp a hand edit broke is made safe to read', async () => {
  const { dir, memoryDb } = memDataDir();
  writeOldChannelFile(dir, 'c1', {
    notesCheckedAt: 7,
    writers: {
      άλφα: { count: 3, last: WRITERS_T0 },
      βήτα: { count: 0, last: WRITERS_T0 },
      γάμα: 'πολύ',
      δέλτα: { count: 2.9, last: 'χθες' },
      έψιλον: { count: 4, last: 1e300 },
    },
  });
  writeOldChannelFile(dir, 'c2', {
    writers: ['άλφα'],
    topWriters: [{ id: 'άλφα', count: 2 }, { id: 'βήτα' }, null, { count: 4 }],
  });
  const store = createStore({ dataDir: dir, memoryDb });

  const channel = store.getChannel(placeOfChat(store, { id: 'c1' }));
  assert.equal(channel?.notesCheckedAt, null);
  assert.deepEqual(channel?.writers, {
    άλφα: { count: 3, last: WRITERS_T0 },
    δέλτα: { count: 2, last: 0 },
    έψιλον: { count: 4, last: 0 },
  });
  assert.deepEqual(
    store.getChannel(placeOfChat(store, { id: 'c2' }))?.writers,
    { άλφα: { count: 2, last: WRITERS_T0 + 5000 } },
    'not a tally: seeded from the usable part of topWriters'
  );
  assert.deepEqual(writeLines(store, 'c1', 'έψιλον', 1, WRITERS_T0 + 6000).topWriters[0], { id: 'έψιλον', count: 5 });
});

// --- interests / details ------------------------------------------------------

test('getUser: a hand-edited details array missing valid ids gets fresh ones assigned, advancing detailsSeq', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  storeWriteRaw(path.join(guildDir, 'u1.json'), {
    id: 'u1',
    names: ['Alice'],
    details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }],
  });

  const store = createStore({ dataDir: dir, memoryDb });
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(asRecord(profile).details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(asRecord(profile).detailsSeq, 3);
});

// --- lore -----------------------------------------------------------------

test('setLore: an owner entry is never overwritten by a later analyzer update', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  store.setLore(
    placeOfRoot(store, 'g1'),
    [{ title: 'Founders Day', keys: ['founders'], text: 'owner text', always: true }],
    {
      source: 'owner',
      by: 'owner',
      now: 1000,
    }
  );

  store.setLore(
    placeOfRoot(store, 'g1'),
    [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer tries to change this' }],
    {
      source: 'analyzer',
      by: 'analyzer',
      now: 2000,
    }
  );

  const entries = store.getLore(placeOfRoot(store, 'g1'));
  assert.equal(entries.length, 1);
  assert.equal(asRecord(entries[0]).text, 'owner text');
  assert.equal(asRecord(entries[0]).source, 'owner');
});

test('setLore: an identical analyzer re-send returns 0 and keeps updatedAt; a changed text returns 1', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const flood = { title: 'The Flood', keys: ['flood'], text: 'It flooded once.' };
  store.setLore(placeOfRoot(store, 'g1'), [flood], { source: 'analyzer', by: 'analyzer', now: 1000 });

  assert.equal(store.setLore(placeOfRoot(store, 'g1'), [flood], { source: 'analyzer', by: 'analyzer', now: 2000 }), 0);
  assert.equal(asRecord(store.getLore(placeOfRoot(store, 'g1'))[0]).updatedAt, new Date(1000).toISOString());

  assert.equal(
    store.setLore(placeOfRoot(store, 'g1'), [{ ...flood, text: 'It flooded twice.' }], {
      source: 'analyzer',
      by: 'analyzer',
      now: 3000,
    }),
    1
  );
  assert.equal(asRecord(store.getLore(placeOfRoot(store, 'g1'))[0]).updatedAt, new Date(3000).toISOString());
});

test('lore: persists across store instances', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.setLore(placeOfRoot(storeA, 'g1'), [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }], {
    source: 'analyzer',
    by: 'analyzer',
    now: 1000,
  });
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const entries = storeB.getLore(placeOfRoot(storeB, 'g1'));
  assert.equal(entries.length, 1);
  assert.equal(asRecord(entries[0]).title, 'The Flood');
});

// --- listUserProfiles -----------------------------------------------------------

test('listUserProfiles: every stored profile of a guild, cached or on disk', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.touchUser(accountOf(store, 'u2'), 'Bob', 1000);
  store.flush();
  await store.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  storeB.touchUser(accountOf(storeB, 'u3'), 'Carl', 1000); // cached only, not yet flushed

  const profiles = storeB.listUserProfiles();
  assert.deepEqual(profiles.map((p) => asRecord(p).id).sort(), ['u1', 'u2', 'u3']);
});

// --- dropCaches / reloadState / validate (/nep pause, /nep resume) ------------

test('dropCaches: forgets every cached unit except state.json, so the next read is a fresh database read', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.setEmojiBackfill(placeOfRoot(store, 'g1'), { at: '2026-10-01T00:00:00.000Z', channels: 1, messages: 1 });
  const { data } = store.state;
  data.llmCount = 3;
  store.state.markDirty();
  store.flush();
  await store.flushSettled({});

  // The expectation on the drop's count went: the store keeps no unit once its write landed, so the drop has nothing
  // to count. The read below is what the pause needs.
  store.dropCaches();

  // A hand-edit made right after the drop is picked up on the very next read.
  storeWriteRaw(path.join(dir, 'guilds', 'g1', 'users', 'u1.json'), {
    id: 'u1',
    names: ['Edited'],
    firstSeen: null,
    lastSeen: null,
    messageCount: 0,
  });
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).names[0], 'Edited');

  // state.json itself was NOT dropped -- still the in-memory value.
  const { data: dataValue } = store.state;
  assert.equal(dataValue.llmCount, 3);
});

test('reloadState: re-reads the stored state, discarding the cached in-memory value', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const { data } = store.state;
  data.llmCount = 1;
  store.state.markDirty();
  store.flush();
  await store.flushSettled({});

  // A hand edit of the stored state, made while paused.
  await writeUnitUpdate(memoryDb, {
    op: 'value',
    key: personaKey('state'),
    value: { llmCount: 99, job: { done: false } },
  });

  const { data: dataValue } = store.state;
  assert.equal(dataValue.llmCount, 1, 'still the stale cached value before reloadState');
  store.reloadState();
  const { data: dataValue3 } = store.state;
  assert.equal(dataValue3.llmCount, 99);
  assert.deepEqual(dataValue3.job, { done: false });
});

test('validate: names every unparsable operational *.json file, path relative to dataDir and forward-slash separated', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  await store.flushSettled({});
  fs.mkdirSync(path.join(dir, 'places', 'g1', 'users'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'users', 'u1.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'inner.json'), '{ not json either');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ also not json');
  // Database-backed state files are retired. Operational guild aliases still require file validation.
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'usage.json'), '{ malformed operational usage');
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'metrics.json'), '{ malformed operational metrics');
  assert.deepEqual(
    store.validate().sort(),
    ['places/g1/metrics.json', 'places/g1/usage.json'],
    'database-authoritative paths are ignored while malformed operational files remain visible'
  );
});

// --- private memory layer (data/guilds/<id>/private/<accountId>.json) -----------

function privateFile(dir: string, placeId: string, accountId: string) {
  return path.join(dir, 'guilds', placeId, 'private', `${accountId}.json`);
}

test('getPrivate: null when no private file exists, and nothing is created', () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  assert.equal(store.getPrivate(accountOf(store, 'u1')), null);
  store.flush();
  assert.equal(existsRaw(privateFile(dir, 'g1', 'u1')), false);
  assert.equal(store.getPrivate(accountOf(store, 'u1')), null);
});

test('getPrivate: a hand-edited file is normalised on read: defaults filled, detail ids assigned', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = privateFile(dir, 'g1', 'u1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  storeWriteRaw(file, {
    relationship: 'Κάτι μυστικό',
    interests: 'not a list',
    details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }],
    affinity: { score: 12 },
    replies: { day: '2026-09-29' },
    buffer: 'garbage',
    episodes: null,
  });

  const store = createStore({ dataDir: dir, memoryDb });
  const priv = store.getPrivate(accountOf(store, 'u1'));
  assert.equal(asRecord(priv).relationship, 'Κάτι μυστικό');
  assert.deepEqual(asRecord(priv).interests, []);
  assert.deepEqual(asRecord(priv).details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(asRecord(priv).detailsSeq, 3);
  assert.deepEqual(asRecord(priv).affinity, { score: 12, reason: '', history: [] });
  assert.equal(asRecord(priv).replies, undefined, 'a stored replies field nothing reads is dropped');
  assert.deepEqual(asRecord(priv).buffer, []);
  assert.deepEqual(asRecord(priv).episodes, []);
  assert.equal(asRecord(priv).firstSeen, '');
  assert.equal(asRecord(priv).lastSeen, '');
});

// --- affinity decay sweep and relationshipScore -------------------------------

const DECAY_DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DECAY_CFG = { decayPerDay: 0.04, decayPower: 1 };

function userFileOf(dir: string, placeId: string, accountId: string) {
  return path.join(dir, 'guilds', placeId, 'users', `${accountId}.json`);
}

test('decayAffinities: decays public and private profiles, marks only the changed ones dirty', async () => {
  const { dir, memoryDb } = memDataDir();
  const dayAgo = new Date(DECAY_NOW - DECAY_DAY_MS).toISOString();
  const hourAgo = new Date(DECAY_NOW - 3600_000).toISOString();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    names: ['Zoé'],
    affinity: { score: 100, reason: 'r', history: [], decayedAt: dayAgo },
  });
  storeWriteRaw(userFileOf(dir, 'g1', 'u2'), {
    id: 'u2',
    names: ['Ἄννα'],
    affinity: { score: 50, reason: '', history: [], decayedAt: hourAgo },
  });
  storeWriteRaw(privateFile(dir, 'g1', 'u1'), {
    relationship: '',
    affinity: { score: -64, reason: '', history: [], decayedAt: dayAgo },
  });
  const untouchedRaw = storeReadRaw(userFileOf(dir, 'g1', 'u2'));

  const store = createStore({ dataDir: dir, memoryDb });
  const counts = store.decayAffinities(DECAY_NOW, DECAY_CFG);
  assert.deepEqual(counts, { profiles: 3, decayed: 2 });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.score, 96);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity.score, -62.36);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u2'))).affinity.score, 50);

  store.flush();
  await store.flushSettled({});
  assert.equal(storeReadRaw(userFileOf(dir, 'g1', 'u2')), untouchedRaw, 'an unchanged profile is not rewritten');
  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.equal(
    asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.score,
    96,
    'the decayed public score was flushed'
  );
  assert.equal(
    asRecord(storeB.getPrivate(accountOf(storeB, 'u1'))).affinity.score,
    -62.36,
    'the decayed private score was flushed'
  );
});

test('decayAffinities: the first sweep only stamps the baseline -- persisted, but nothing counts as decayed', async () => {
  const { dir, memoryDb } = memDataDir();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    names: ['Zoé'],
    affinity: { score: 80, reason: '', history: [] },
  });
  storeWriteRaw(privateFile(dir, 'g1', 'u1'), { relationship: '', affinity: { score: 20, reason: '', history: [] } });

  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.decayAffinities(DECAY_NOW, DECAY_CFG), { profiles: 2, decayed: 0 });
  store.flush();
  await store.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.equal(asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.score, 80);
  assert.equal(asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(
    asRecord(storeB.getPrivate(accountOf(storeB, 'u1'))).affinity.decayedAt,
    new Date(DECAY_NOW).toISOString()
  );
  assert.deepEqual(storeB.decayAffinities(DECAY_NOW + DECAY_DAY_MS, DECAY_CFG), { profiles: 2, decayed: 2 });
});

test('decayAffinities: decay off writes nothing; no profiles -> zero counts', async () => {
  const { dir, memoryDb } = memDataDir();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', affinity: { score: 80, reason: '', history: [] } });
  const raw = storeReadRaw(userFileOf(dir, 'g1', 'u1'));
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.decayAffinities(DECAY_NOW, { decayPerDay: 0 }), { profiles: 1, decayed: 0 });
  store.flush();
  await store.flushSettled({});
  assert.equal(storeReadRaw(userFileOf(dir, 'g1', 'u1')), raw);
  // Profiles are the persona's now: a store with none is another database.
  assert.deepEqual(createStore(memoryAt(storeTmpDataDir())).decayAffinities(DECAY_NOW, DECAY_CFG), {
    profiles: 0,
    decayed: 0,
  });
});

test('normalisation on read keeps decayedAt and relationshipScore, public and private', async () => {
  const { dir, memoryDb } = memDataDir();
  const stamp = new Date(DECAY_NOW).toISOString();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    relationship: 'x',
    relationshipScore: 42,
    affinity: { score: 10, reason: '', history: [], decayedAt: stamp },
  });
  storeWriteRaw(privateFile(dir, 'g1', 'u1'), {
    relationship: 'y',
    relationshipScore: -9,
    affinity: { score: 10, decayedAt: stamp },
  });
  const store = createStore({ dataDir: dir, memoryDb });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore, 42);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipScore, -9);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
});

// Three sentences of about 40 characters each, longer in all than any old limit of the relationship text.
// --- self facts ----

const STORE_ELENI = '111111111111111111';

// --- the recent store (data/guilds/<id>/recent.json, src/memory/recent.ts) ------

const STORE_RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RECENT_HOUR = 60 * 60 * 1000;
const STORE_AGORA = '900000000000000001';

function storeRecentFileOf(dir: string, placeId: string) {
  return path.join(dir, 'guilds', placeId, 'recent.json');
}

test('store: getRecent on a fresh guild creates no unit', async () => {
  const dir = storeTmpDataDir();
  const store = createStore(memoryAt(dir));
  assert.deepEqual(store.getRecent(placeOfRoot(store, 'g1')), { nextId: 1, lines: [] });
  store.flush();
  await store.flushSettled({});
  assert.equal(existsRaw(storeRecentFileOf(dir, 'g1')), false);
});

test('store: stored recent lines read back normalised, and the copy changes nothing stored', async () => {
  const { dir, memoryDb } = memDataDir();
  const at = STORE_RECENT_NOW - RECENT_HOUR;
  await storeWriteRaw(storeRecentFileOf(dir, 'g1'), {
    nextId: 2,
    lines: [
      {
        id: 1,
        at,
        addedAt: 'χθες',
        placeId: STORE_AGORA,
        text: `<@${STORE_ELENI}> έφερε\nσύκα`,
        weight: 7,
        itemId: 'rc-1',
      },
      { id: 1, at, placeId: STORE_AGORA, text: 'βράδυ με βροχή', who: ['ψέμα'], weight: 'βαρύ' },
    ],
  });
  const store = createStore({ dataDir: dir, memoryDb });
  const recent = store.getRecent(placeOfRoot(store, 'g1'));
  assert.deepEqual(recent, {
    nextId: 3,
    lines: [
      {
        id: 1,
        at,
        addedAt: 'χθες',
        placeId: STORE_AGORA,
        text: `<@${STORE_ELENI}> έφερε σύκα`,
        who: [STORE_ELENI],
        weight: 3,
        itemId: 'rc-1',
      },
      { id: 2, at, addedAt: null, placeId: STORE_AGORA, text: 'βράδυ με βροχή', who: [], weight: 2 },
    ],
  });
  recent.lines.length = 0;
  assert.equal(store.getRecent(placeOfRoot(store, 'g1')).lines.length, 2);
});

// ---- version history of prose fields ---------------------------------------

function storeWithStore(fn: Untyped) {
  const { dir, memoryDb } = memDataDir();
  return fn(createStore({ dataDir: dir, memoryDb }), dir, memoryDb);
}

/** The previous texts the store kept of the lorebook entry `title` of the place g1, as the database holds them. */
function loreVersions(memoryDb: Untyped, title: string): Array<Untyped> | undefined {
  return asRecord(storeUnitOf(memoryDb, `guilds/g1/versions/lore/${loreVersionKey(title)}.json`))?.text;
}

const lore = (text: string, title = 'Ο Κήπος') => [{ title, keys: ['κήπος'], text }];

test('setLore: a changed text keeps the previous one with who wrote it and a sentence diff; a first write records nothing', () =>
  storeWithStore(async (store: Untyped, _dir: Untyped, memoryDb: Untyped) => {
    const g1 = placeOfRoot(store, 'g1');
    store.setLore(g1, lore('Ένα. Δύο.'), { source: 'owner', by: 'owner', now: 1000 });
    store.flush();
    await store.flushSettled({});
    assert.equal(loreVersions(memoryDb, 'Ο Κήπος'), undefined, 'first write');

    const { logs } = await withCapturedLogs(() =>
      store.setLore(g1, lore('Δύο. Τρία.'), { source: 'owner', by: 'owner', now: Date.UTC(2026, 9, 1) })
    );
    store.flush();
    await store.flushSettled({});
    const [version] = loreVersions(memoryDb, ' ο κήπος ') ?? [];
    assert.deepEqual(
      [version.text, version.by, version.chars, version.at],
      ['Ένα. Δύο.', 'owner', 9, '2026-10-01T00:00:00.000Z']
    );
    assert.deepEqual([version.before, version.after, version.kept, version.removed, version.added], [2, 2, 1, 1, 1]);
    assert.match(version.itemId, /^vs-/);
    const recorded = logs.find((entry) => entry.msg === 'store: version recorded');
    assert.deepEqual([recorded?.kind, recorded?.field, recorded?.chars], ['lore', 'text', 9]);
    assert.ok(!JSON.stringify(logs).includes('Ένα'), 'counts only');
  }));

test('setLore: a blank previous text a hand edit left records no version', () =>
  storeWithStore(async (store: Untyped, dir: Untyped, memoryDb: Untyped) => {
    const g1 = placeOfRoot(store, 'g1');
    await storeWriteRaw(path.join(dir, 'guilds', 'g1', 'lore.json'), [
      { id: 'l1', title: 'Ο Κήπος', keys: ['κήπος'], text: ' ', source: 'owner', always: false, weight: 1 },
    ]);
    assert.equal(store.setLore(g1, lore('Νέο.'), { source: 'owner', by: 'owner', now: 1000 }), 1);
    store.flush();
    await store.flushSettled({});
    assert.equal(loreVersions(memoryDb, 'Ο Κήπος'), undefined);
  }));

test('setLore: past 20 versions of an entry the oldest goes', () =>
  storeWithStore(async (store: Untyped, _dir: Untyped, memoryDb: Untyped) => {
    const g1 = placeOfRoot(store, 'g1');
    for (let n = 0; n <= 21; n += 1) store.setLore(g1, lore(`Κείμενο ${n}.`), { source: 'owner', by: 'owner', now: n });
    store.flush();
    await store.flushSettled({});
    const texts = (loreVersions(memoryDb, 'Ο Κήπος') ?? []).map((version: Untyped) => version.text);
    assert.equal(texts.length, 20);
    assert.deepEqual([texts[0], texts.at(-1)], ['Κείμενο 1.', 'Κείμενο 20.']);
  }));

test('store: version units are not mistaken for channel or user ids', () =>
  storeWithStore(async (store: Untyped, dir: Untyped, memoryDb: Untyped) => {
    store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
    store.touchChannel(placeOfChat(store, { id: 'c1' }), { name: 'αγορά' }, 1000);
    for (const text of ['Un.', 'Deux.'])
      store.setLore(placeOfRoot(store, 'g1'), [{ title: 'T', keys: ['tt'], text }], {
        source: 'owner',
        by: 'owner',
        now: 1,
      });
    const check = (s: Untyped) => {
      assert.deepEqual(
        s.listChannels(placeOfRoot(s, 'g1')).map((c: Untyped) => c.id),
        ['c1']
      );
      assert.deepEqual(
        s.listUserProfiles().map((p: Untyped) => p.id),
        ['u1']
      );
    };
    store.flush();
    await store.flushSettled({});
    assert.equal(loreVersions(memoryDb, 'T')?.length, 1);
    underTop(memoryDb, placeOfRoot(store, 'g1'), placeOfChat(store, { id: 'c1' }));
    check(store);
    check(createStore({ dataDir: dir, memoryDb }));
  }));

// ---- the participation store (src/memory/participation.ts) ---------------------

const PART_AT = Date.UTC(2026, 9, 10, 12, 0, 0);
const PART_MIN = 60_000;

/** A store state with one episode in `placeId`: a line of `authorId`, then the persona's. */
function partState(state: unknown, { placeId, minute, authorId = 'u1' }: Untyped) {
  const before = [
    {
      id: `m${placeId}${minute}`,
      ts: PART_AT + (minute - 1) * PART_MIN,
      authorId,
      name: 'Zoé',
      self: false,
      text: 'καλημέρα',
      replyTo: null,
      caption: null,
    },
  ];
  const own = {
    id: `o${placeId}${minute}`,
    ts: PART_AT + minute * PART_MIN,
    authorId: 'bot',
    name: 'persona',
    self: true,
    text: 'γεια σου',
    replyTo: null,
    caption: null,
  };
  return recordOwnLine(state, { placeId, own, before }, PARTICIPATION_DEFAULTS, PART_AT + minute * PART_MIN);
}

test('store: participation round trip, a copy on read, nothing created by reading', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds() });
  const file = path.join(dir, 'guilds', 'g1', 'participation.json');
  assert.deepEqual(store.getParticipation(placeOfRoot(store, 'g1')), { episodes: [], nextId: 1 });
  store.flush();
  await store.flushSettled({});
  assert.equal(existsRaw(file), false);

  const state = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  store.setParticipation(placeOfRoot(store, 'g1'), state, { settings: PARTICIPATION_DEFAULTS, now: PART_AT });
  const copy = store.getParticipation(placeOfRoot(store, 'g1'));
  const stored = { ...state, episodes: state.episodes.map((ep) => ({ ...ep, itemId: 'pt-u1' })) };
  assert.deepEqual(copy, stored);
  copy.episodes.length = 0;
  assert.equal(store.getParticipation(placeOfRoot(store, 'g1')).episodes.length, 1);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(createStore({ dataDir: dir, memoryDb }).getParticipation(placeOfRoot(store, 'g1')), stored);
});

test('store: participation expires on every write', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  let state = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  state = partState(state, { placeId: 'c2', minute: 120 });
  state = partState(state, { placeId: 'c3', minute: 240 });
  store.setParticipation(placeOfRoot(store, 'g1'), state, {
    settings: { ...PARTICIPATION_DEFAULTS, hours: 3 },
    now: PART_AT + 5 * 60 * PART_MIN,
  });
  assert.deepEqual(
    store.getParticipation(placeOfRoot(store, 'g1')).episodes.map((ep) => asRecord(ep).placeId),
    ['c2', 'c3']
  );
  store.setParticipation(placeOfRoot(store, 'g1'), state, {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 1 },
    now: PART_AT + 5 * 60 * PART_MIN,
  });
  assert.deepEqual(
    store.getParticipation(placeOfRoot(store, 'g1')).episodes.map((ep) => asRecord(ep).placeId),
    ['c3']
  );
});

test('store: a broken participation file reads as a store and is logged once', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = (id: string) => path.join(dir, 'guilds', id);
  const good = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  await storeWriteRaw(path.join(guildDir('g1'), 'participation.json'), {
    nextId: 2,
    episodes: [...good.episodes, { id: 'p9' }, 'όχι'],
  });
  await storeWriteRaw(path.join(guildDir('g2'), 'participation.json'), { episodes: 'κανένα' });
  const store = createStore({ dataDir: dir, memoryDb });
  const { result, logs } = await withCapturedLogs(() => [
    store.getParticipation(placeOfRoot(store, 'g1')),
    store.getParticipation(placeOfRoot(store, 'g1')),
    store.getParticipation(placeOfRoot(store, 'g2')),
    store.getParticipation(placeOfRoot(store, 'g3')),
  ]);
  assert.deepEqual(result[0], good);
  assert.deepEqual(result[2], { episodes: [], nextId: 1 });
  assert.deepEqual(result[3], { episodes: [], nextId: 1 });
  assert.deepEqual(
    logs
      .filter((entry) => entry.msg.startsWith('store: participation'))
      .map((entry) => [entry.msg, entry.placeId, entry.reason ?? entry.dropped]),
    [
      ['store: participation episodes dropped', 'discord:server:g1', 2],
      ['store: participation store replaced', 'discord:server:g2', 'malformed'],
    ]
  );
});

// ---- itemId and what every write drops ----------------------------------------------------

/** A counter standing in for randomUUID, so the ids a test sees are predictable. */
function counterIds() {
  let n = 0;
  return () => {
    n += 1;
    return `u${n}`;
  };
}

const ID_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test('store: eviction returns the dropped items with their itemId', () => {
  const dir = storeTmpDataDir();
  const store = createStore({ ...memoryAt(dir), newId: counterIds() });

  const posts = ['ένα', 'δύο', 'τρία'].map((gist, i) => ({
    at: ID_NOW + i,
    kind: null,
    gist,
    picture: null,
    messageIds: [],
    search: '',
  }));
  store.setDiaryPosts(posts.slice(0, 2), { max: 2, now: ID_NOW });
  const firstPostId = asRecord(store.getDiary().posts[0]).itemId;
  const diary = store.appendDiaryPost(posts[2], { max: 2, now: ID_NOW });
  assert.deepEqual(
    diary.dropped.map((p) => [asRecord(p).gist, asRecord(p).itemId]),
    [['ένα', firstPostId]]
  );
  assert.ok(firstPostId.startsWith('dy-u'));

  const own = (id: string, ts: number) => ({ id, ts, authorId: 'bot', name: 'persona', self: true, text: 'γεια' });
  let part = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o1', ID_NOW) },
    PARTICIPATION_DEFAULTS,
    ID_NOW
  );
  store.setParticipation(placeOfRoot(store, 'g1'), part, { settings: PARTICIPATION_DEFAULTS, now: ID_NOW });
  const episodeId = asRecord(store.getParticipation(placeOfRoot(store, 'g1')).episodes[0]).itemId;
  part = recordOwnLine(
    store.getParticipation(placeOfRoot(store, 'g1')),
    { placeId: 'c2', own: own('o2', ID_NOW + 1000) },
    PARTICIPATION_DEFAULTS,
    ID_NOW + 1000
  );
  const { dropped } = store.setParticipation(placeOfRoot(store, 'g1'), part, {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 1 },
    now: ID_NOW + 1000,
  });
  assert.deepEqual(
    dropped.map((ep) => asRecord(ep).itemId),
    [episodeId]
  );
});

// ---- the archive (src/memory/archive.ts): nothing leaves a hot list without a copy ----

/** The channels of the stored participation episodes of g1, in stored order. */
const episodePlaces = (episodes: Array<object>): Array<string> => episodes.map((ep) => asRecord(ep).placeId);

/** A participation store at the cap of two takes the episode of `placeId` at `minute`: the oldest is its victim. */
function participateAt(store: Untyped, placeId: string, minute: number) {
  const g1 = placeOfRoot(store, 'g1');
  const state = partState(store.getParticipation(g1), { placeId, minute });
  return store.setParticipation(g1, state, {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 2 },
    now: PART_AT + minute * PART_MIN,
  });
}

test('store: an evicted episode is archived before the stored unit loses it', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ manual: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const file = path.join(dir, 'guilds', 'g1', 'participation.json');
  const hot = () => episodePlaces(store.getParticipation(placeOfRoot(store, 'g1')).episodes);
  // Every write of the unit, in order with the archive's answer.
  const write = async () => {
    store.flush();
    await storeSettle();
    const onDisk = episodePlaces(JSON.parse(storeReadRaw(file)).episodes);
    archive.events.push(onDisk.includes('c1') ? 'write-with' : 'write-without');
  };
  participateAt(store, 'c1', 0);
  participateAt(store, 'c2', 10);
  await write();

  const { dropped } = participateAt(store, 'c3', 20);
  assert.deepEqual(hot(), ['c1', 'c2', 'c3'], 'the victim stays hot, over the cap');
  await write();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.appended.length, 1, 'the append runs in the background');
  const [{ placeId, entries }] = archive.appended;
  // The archive of a store unit is the persona's: the scope names the channel.
  assert.equal(placeId, null);
  assert.deepEqual(
    asRecord(entries).map((entry: Untyped) => [entry.itemKind, entry.event, entry.scope, entry.itemId]),
    [['participation', 'evicted', { channel: 'c1' }, asRecord(dropped[0]).itemId]]
  );
  await write();

  const { logs } = await withCapturedLogs(async () => {
    archive.releases.shift()?.();
    await storeSettle();
  });
  assert.deepEqual(hot(), ['c2', 'c3'], 'trimmed once confirmed');
  assert.ok(logs.some((entry) => entry.msg === 'store: archive trimmed' && entry.trimmed === 1));
  await write();

  const resolved = archive.events.indexOf('append-resolved');
  assert.ok(resolved > 0, JSON.stringify(archive.events));
  assert.ok(
    archive.events.slice(0, resolved).every((event) => event === 'write-with'),
    JSON.stringify(archive.events)
  );
  assert.equal(archive.events.at(-1), 'write-without');

  // With features.archive off (archiveOn false) a victim leaves at once and nothing is archived.
  const offArchive = fakeArchive();
  const off = createStore({
    ...memoryAt(storeTmpDataDir()),
    newId: counterIds(),
    archive: offArchive,
    archiveOn: () => false,
  });
  for (const [placeId, minute] of [
    ['c1', 0],
    ['c2', 10],
    ['c3', 20],
  ] as const)
    participateAt(off, placeId, minute);
  assert.deepEqual(episodePlaces(off.getParticipation(placeOfRoot(off, 'g1')).episodes), ['c2', 'c3']);
  await storeSettle();
  assert.equal(offArchive.appended.length, 0);
});

test('store: a failing archive keeps every victim hot and queues it once; the drain archives and trims', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ fail: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const hot = () => episodePlaces(store.getParticipation(placeOfRoot(store, 'g1')).episodes);
  participateAt(store, 'c1', 0);
  participateAt(store, 'c2', 10);

  const { logs } = await withCapturedLogs(async () => {
    participateAt(store, 'c3', 20);
    await storeSettle();
  });
  assert.ok(
    logs.some((entry) => entry.msg === 'store: archive failed' && entry.entries === 1),
    'counts only'
  );
  assert.deepEqual(hot(), ['c1', 'c2', 'c3'], 'the victim stays hot');
  assert.deepEqual(
    archive.pending.map((item) => [asRecord(item).placeId, asRecord(item).entry.itemKind]),
    [[null, 'participation']]
  );
  store.flush();
  await store.flushSettled({});
  const file = path.join(dir, 'guilds', 'g1', 'participation.json');
  assert.equal(JSON.parse(storeReadRaw(file)).episodes.length, 3, 'stored too');

  // A later write drops the same victim again and a new one: only the new one is queued.
  participateAt(store, 'c4', 30);
  await storeSettle();
  assert.deepEqual(
    archive.pending.map((item) => asRecord(item).entry.scope.channel),
    ['c1', 'c2']
  );

  assert.deepEqual(await store.drainArchive(), { archived: 2, left: 0 });
  assert.deepEqual(hot(), ['c3', 'c4']);
  store.flush();
  await store.flushSettled({});
  assert.equal(JSON.parse(storeReadRaw(file)).episodes.length, 2);
});

// ---- the real name and the names people use (src/memory/addressed.ts) ----

test('getUser: addressedAs and realName are normalised on read, absent stays absent', async () => {
  const { dir, memoryDb } = memDataDir();
  const last = new Date(ID_NOW).toISOString();
  storeWriteRaw(path.join(dir, 'guilds', 'g1', 'users', 'u1.json'), {
    id: 'u1',
    names: ['Ana'],
    addressedAs: { Ana: { score: 2, last }, broken: { score: 'x' }, worse: 1 },
    realName: { name: 'Anaïs', from: 'never', to: '2020-01-01', itemId: 'rn-1', junk: true },
  });
  storeWriteRaw(path.join(dir, 'guilds', 'g1', 'users', 'u2.json'), {
    id: 'u2',
    names: ['Bo'],
    realName: { name: '' },
    addressedAs: [1],
  });
  storeWriteRaw(path.join(dir, 'guilds', 'g1', 'users', 'u3.json'), { id: 'u3', names: ['Cy'] });
  const store = createStore({ dataDir: dir, memoryDb });
  const one = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(asRecord(one).addressedAs, { Ana: { score: 2, last } });
  assert.deepEqual(asRecord(one).realName, { name: 'Anaïs', from: null, to: null, itemId: 'rn-1' });
  const two = store.getUser(accountOf(store, 'u2'));
  assert.equal('realName' in asRecord(two), false);
  assert.deepEqual(asRecord(two).addressedAs, {});
  const three = store.getUser(accountOf(store, 'u3'));
  assert.equal('realName' in asRecord(three), false);
  assert.equal('addressedAs' in asRecord(three), false);
});

test('recordAddressUses: folds uses into an existing profile only, with the half-life given', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  assert.equal(
    store.recordAddressUses(accountOf(store, 'nobody'), [{ name: 'Ana', at: ID_NOW }], { halfLifeDays: 30 }),
    null
  );
  assert.equal(store.getUser(accountOf(store, 'nobody')), null);
  store.touchUser(accountOf(store, 'u1'), 'Ana', ID_NOW);
  store.recordAddressUses(accountOf(store, 'u1'), [{ name: 'Ana', at: ID_NOW }], { halfLifeDays: 30 });
  store.recordAddressUses(accountOf(store, 'u1'), [{ name: 'ana', at: ID_NOW + 30 * 86_400_000 }], {
    halfLifeDays: 30,
  });
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).addressedAs, {
    Ana: { score: 1.5, last: new Date(ID_NOW + 30 * 86_400_000).toISOString() },
  });
});

// ---- the kept contract: hand edits read safely, the small writers, restore, the archive's edges ----

test('getUser and getPrivate: an avatar, a real name stamp and a closed list a hand edit left are read safely', async () => {
  const { dir, memoryDb } = memDataDir();
  const avatar = { hash: 'a1b2', text: 'μια γάτα', describedAt: '2026-10-01T00:00:00.000Z' };
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    names: 'Zoé',
    avatar,
    realName: { name: 'Zoé', from: '2020-01-01', recordedAt: '2026-10-01' },
    closed: [{ kind: 'interest', topic: 'σκάκι' }, { kind: 'mood' }, 'όχι'],
  });
  storeWriteRaw(userFileOf(dir, 'g1', 'u2'), { id: 'u2', avatar: { hash: 'x' }, closed: 'κανένα' });
  storeWriteRaw(privateFile(dir, 'g1', 'u1'), {
    relationship: 7,
    affinity: [1],
    closed: [{ kind: 'detail', text: 'α' }],
  });
  storeWriteRaw(privateFile(dir, 'g1', 'u2'), { affinity: { score: 'πολύ', reason: 3, history: 'όχι' } });
  const store = createStore({ dataDir: dir, memoryDb });
  const one = asRecord(store.getUser(accountOf(store, 'u1')));
  assert.deepEqual(one.avatar, avatar);
  assert.deepEqual(one.realName, { name: 'Zoé', from: '2020-01-01', to: null, recordedAt: '2026-10-01' });
  assert.deepEqual(one.closed, [{ kind: 'interest', topic: 'σκάκι' }]);
  const two = asRecord(store.getUser(accountOf(store, 'u2')));
  assert.equal('avatar' in two, false, 'a broken avatar goes');
  assert.deepEqual(two.closed, []);
  const layer = asRecord(store.getPrivate(accountOf(store, 'u1')));
  assert.deepEqual(
    [layer.relationship, layer.affinity, layer.closed],
    ['', { score: 0, reason: '', history: [] }, [{ kind: 'detail', text: 'α' }]]
  );
  assert.deepEqual(asRecord(store.getPrivate(accountOf(store, 'u2'))).affinity, { score: 0, reason: '', history: [] });
  // The names a hand edit left as no list start over with the next touch.
  assert.deepEqual(asRecord(store.touchUser(accountOf(store, 'u1'), 'Ζωή', 2000)).names, ['Ζωή']);
});

test('setAvatar: only an existing profile takes a valid avatar, on the account and without moving updatedAt', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const avatar = { hash: 'a1b2', text: 'μια γάτα', describedAt: '2026-10-01T00:00:00.000Z' };
  assert.equal(store.setAvatar(accountOf(store, 'u1'), avatar), null);
  assert.equal(store.getUser(accountOf(store, 'u1')), null, 'no profile is created');
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  assert.equal(store.setAvatar(accountOf(store, 'u1'), { hash: 'a1b2' }), null, 'an avatar without a text');
  assert.deepEqual(asRecord(store.setAvatar(accountOf(store, 'u1'), avatar)).avatar, avatar);
  store.flush();
  await store.flushSettled({});
  const restarted = asRecord(createStore({ dataDir: dir, memoryDb }).getUser(accountOf(store, 'u1')));
  assert.deepEqual([restarted.avatar, restarted.updatedAt], [avatar, null]);
});

test('emoji usage: counted uses persist, nothing counted writes nothing, the backfill clears and stamps', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  const message = (ts: number, ids: Array<string>) => ({ ts, self: false, emojis: ids.map((id) => ({ id })) });
  assert.equal(store.recordEmojiUsage(g1, [{ ts: 1, self: true, emojis: [{ id: 'e1' }] }]), 0);
  store.flush();
  await store.flushSettled({});
  assert.equal(existsRaw(path.join(dir, 'guilds', 'g1', 'guild.json')), false, 'nothing counted, nothing written');

  assert.equal(store.recordEmojiUsage(g1, [message(10, ['e1', 'e2']), message(20, ['e1'])], { storeMax: 1 }), 3);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(asRecord(createStore({ dataDir: dir, memoryDb }).getPlace(g1)).emojiUsage, {
    e1: { count: 2, last: 20 },
  });

  store.clearEmojiUsage(g1);
  assert.deepEqual(store.setEmojiBackfill(g1, { at: '2026-10-01T00:00:00.000Z', channels: 2.7, messages: -1 }), {
    at: '2026-10-01T00:00:00.000Z',
    channels: 2,
    messages: 0,
  });
  store.flush();
  await store.flushSettled({});
  const place = asRecord(createStore({ dataDir: dir, memoryDb }).getPlace(g1));
  assert.deepEqual([place.emojiUsage, place.emojiBackfill.channels], [{}, 2]);
});

test('noteRoots and notePlaceAddress go through the writer and log a refused write; a store without a writer writes nothing', async () => {
  const { dir, memoryDb } = memDataDir();
  const sent: Array<Untyped> = [];
  let refuse = false;
  const recording = {
    ...memoryDb,
    memoryWrite: (update: Untyped) => {
      sent.push(update);
      return refuse ? Promise.reject(Object.assign(new Error('closed'), { code: 'DB_CLOSED' })) : Promise.resolve(1);
    },
  };
  const store = createStore({ dataDir: dir, memoryDb: recording });
  store.noteRoots('discord', [{ id: 'g1', name: 'αγορά' }]);
  store.noteRoots('discord', [{ id: 'g2', name: 'κήπος' }], { name: 'Δίσκος' } as Untyped);
  assert.equal(await store.notePlaceAddress('discord:dm:u1', 'chat-9'), 1);
  assert.deepEqual(
    sent.map((update) => [update.kind, update.iface ?? update.placeId, update.names ?? update.address ?? null]),
    [
      ['roots', 'discord', null],
      ['roots', 'discord', { name: 'Δίσκος' }],
      ['place-address', 'discord:dm:u1', 'chat-9'],
    ]
  );
  refuse = true;
  const { logs } = await withCapturedLogs(async () => {
    store.noteRoots('discord', [{ id: 'g1', name: 'αγορά' }]);
    await store.notePlaceAddress('discord:dm:u1', 'chat-9');
    await storeSettle();
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg.includes('write failed')).map((entry) => entry.msg),
    ['store: roots write failed', 'store: place address write failed']
  );

  // The read-only store of a replay has no writer: nothing is written, and a recall trace is refused.
  const readOnly = { readHandle: () => memoryDb.readHandle() };
  const replayStore = createStore({ dataDir: dir, memoryDb: readOnly });
  replayStore.noteRoots('discord', [{ id: 'g1', name: 'αγορά' }]);
  assert.equal(await replayStore.notePlaceAddress('discord:dm:u1', 'chat-9'), null);
  assert.throws(
    () => replayStore.appendRecallTrace(placeOfRoot(replayStore, 'g1'), { run: 1 }),
    (error: Untyped) => error.code === 'DB_CLOSED'
  );
});

test('a closed database: a read is refused, a profile in use is still read', async () => {
  const mem = await openTestMemory();
  const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
  const row = store.readMemory((db) =>
    (db as { prepare(sql: string): { get(): Untyped } }).prepare('SELECT 1 AS one').get()
  );
  assert.equal(asRecord(row).one, 1);
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  await mem.close();
  const closed = (error: Untyped) => error.code === 'DB_CLOSED';
  assert.throws(() => store.readMemory(() => 'never'), closed);
  assert.throws(() => store.gifMediaVectors('model'), closed);
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).names, ['Zoé']);
});

test('appendRecallTrace keeps 500 lines when the cap given is no number of at least one', async () => {
  const mem = await openTestMemory();
  try {
    const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    for (let run = 1; run <= 501; run += 1) store.appendRecallTrace(placeOfRoot(store, 'g1'), { run }, { maxLines: 0 });
    await store.flushSettled({});
    const lines = unitLines(mem.memoryDb.readHandle()?.db, placeCollection('recall_trace', placeOfRoot(store, 'g1')));
    assert.deepEqual([lines.length, lines[0]], [500, JSON.stringify({ run: 2 })]);
  } finally {
    await mem.close();
  }
});

test('emoji rails are null before the first, then kept as given', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const g1 = placeOfRoot(store, 'g1');
  assert.equal(store.getEmojiRails(g1), null);
  store.setEmojiRails(g1, { recent: ['e1'] });
  assert.deepEqual(store.getEmojiRails(g1), { recent: ['e1'] });
});

test('removeLore takes one entry out by id, and says when there was none', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const g1 = placeOfRoot(store, 'g1');
  store.setLore(g1, lore('Ένα.', 'Α'), { source: 'owner', by: 'owner', now: 1 });
  store.setLore(g1, lore('Δύο.', 'Β'), { source: 'owner', by: 'owner', now: 1 });
  const [first] = store.getLore(g1).map((entry) => asRecord(entry));
  assert.equal(store.removeLore(g1, first.id), true);
  assert.equal(store.removeLore(g1, first.id), false);
  assert.deepEqual(
    store.getLore(g1).map((entry) => asRecord(entry).title),
    ['Β']
  );
});

test('touchChannel: a message whose channel has no topic stores null; an unknown channel reads null', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' })), null);
  store.touchChannel(placeOfChat(store, { id: 'c1' }), { name: 'αγορά' }, WRITERS_T0);
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.topic, null);
});

test('a stored channel whose top writers a hand edit broke seeds no tally', async () => {
  const { dir, memoryDb } = memDataDir();
  writeOldChannelFile(dir, 'c1', { topWriters: 7 });
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.getChannel(placeOfChat(store, { id: 'c1' }))?.writers, {});
});

test('recordGifs counts a message that names no place on the place given; a described entry names the GIF', () => {
  const store = createStore(memoryAt(storeTmpDataDir()));
  const c1 = placeOfChat(store, { id: 'c1' });
  const gif = { id: 'm1', ts: WRITERS_T0, attachments: [] };
  const counted = store.recordGifs(c1, [
    {
      ...gif,
      links: [{ id: 'm1#e0', kind: 'gif', site: 'Tenor', title: '', text: '', url: 'https://tenor.com/view/a-1' }],
    },
  ]);
  assert.equal(counted, 1);
  const [key] = Object.keys(store.getGifs().entries);
  const { places } = store.getGifs().entries[key];
  assert.equal(places?.[c1]?.count, 1);
  store.putMediaEntry(c1, key, { text: 'μια γάτα χορεύει', ts: WRITERS_T0 });
  assert.equal(store.getGifs().entries[key].description, 'μια γάτα χορεύει');
  store.resetGifCounts(c1);
  const { places: placesAfterReset } = store.getGifs().entries[key];
  assert.equal(placesAfterReset?.[c1]?.count, 0);
});

test('restoreArchived puts an item back where its kind lives, once, without links', async () => {
  const { dir, memoryDb } = memDataDir();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', names: ['Zoé'] });
  storeWriteRaw(privateFile(dir, 'g1', 'u1'), { relationship: '' });
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  const u1 = accountOf(store, 'u1');
  const restore = (entry: Untyped) => store.restoreArchived(g1, entry);
  const interest = {
    itemKind: 'interest',
    scope: { user: u1 },
    itemId: 'in-1',
    text: { topic: 'σκάκι', note: 'παίζει https://example.com/x' },
    stored: { firstSeen: '2026-01-01T00:00:00.000Z' },
    weight: 3,
  };
  assert.deepEqual(restore(interest), {
    restored: true,
    item: { firstSeen: '2026-01-01T00:00:00.000Z', topic: 'σκάκι', note: 'παίζει', weight: 3, itemId: 'in-1' },
  });
  assert.deepEqual(restore(interest), { restored: false, reason: 'hot' });
  assert.deepEqual(
    asRecord(store.getUser(u1)).interests.map((item: Untyped) => item.itemId),
    ['in-1']
  );
  // A profile a hand edit left without episodes takes the restored one as its first.
  assert.equal(restore({ itemKind: 'episode', scope: { user: u1 }, itemId: 'ep-1', text: 'σπασμένο' }).restored, true);
  assert.deepEqual(asRecord(store.getUser(u1)).episodes, [{ itemId: 'ep-1' }]);

  const detail = {
    itemKind: 'detail',
    scope: { user: u1, private: true },
    itemId: 'dt-1',
    text: { text: 'ζει στη Λάρισα' },
  };
  assert.equal(restore(detail).restored, true);
  assert.deepEqual(
    asRecord(store.getPrivate(u1)).details.map((item: Untyped) => item.text),
    ['ζει στη Λάρισα']
  );
  assert.deepEqual(restore({ ...detail, scope: { user: accountOf(store, 'u2'), private: true } }), {
    restored: false,
    reason: 'no-profile',
  });
  assert.deepEqual(restore({ ...interest, scope: { user: accountOf(store, 'u2') } }), {
    restored: false,
    reason: 'no-profile',
  });
  for (const unknown of [
    { itemKind: 'alias', scope: { user: u1, private: true }, itemId: 'al-1', text: { name: 'Ζ' } },
    { itemKind: 'interest', scope: {}, itemId: 'in-2', text: { topic: 'χωρίς κάτοχο' } },
    { itemKind: 'move', scope: { user: u1 }, itemId: 'mv-1', text: { reason: 'α' } },
    { itemKind: 'selfFact', scope: { place: g1 }, itemId: 'sf-1', text: { text: 'https://example.com/only' } },
  ])
    assert.deepEqual(restore(unknown), { restored: false, reason: 'kind' }, unknown.itemKind);
  assert.equal(restore({ itemKind: 'alias', scope: { user: u1 }, itemId: 'al-2', text: { name: 'Ζ' } }).restored, true);

  assert.deepEqual(
    restore({ itemKind: 'selfFact', scope: { place: g1 }, itemId: 'sf-2', text: { text: 'πίνω τσάι' } }),
    {
      restored: true,
      item: 'πίνω τσάι',
    }
  );
  assert.deepEqual(
    restore({ itemKind: 'injoke', scope: { place: g1 }, itemId: 'ij-1', text: { text: ' Πίνω   ΤΣΑΙ ' } }),
    {
      restored: true,
      item: ' Πίνω   ΤΣΑΙ ',
    }
  );
  assert.deepEqual(restore({ itemKind: 'injoke', scope: { place: g1 }, itemId: 'ij-2', text: { text: 'πίνω τσαι' } }), {
    restored: false,
    reason: 'hot',
  });
  assert.equal(
    restore({ itemKind: 'lesson', scope: { place: g1 }, itemId: 'ln-1', text: { text: 'α' } }).restored,
    true
  );
  assert.deepEqual(
    asRecord(store.getPlace(g1)).learned.map((item: Untyped) => item.itemId),
    ['ln-1']
  );
  assert.equal(restore({ itemKind: 'diary', scope: {}, itemId: 'dy-1', text: { gist: 'μια μέρα' } }).restored, true);
  assert.deepEqual(
    store.getDiary().posts.map((post) => asRecord(post).gist),
    ['μια μέρα']
  );
  store.flush();
  await store.flushSettled({});
  assert.equal(asRecord(createStore({ dataDir: dir, memoryDb }).getUser(u1)).interests[0].note, 'παίζει');
});

/** A fake archive whose append (with no code) and pending queue (with `state.code`, if any) refuse while `down`. */
function brokenArchive() {
  const archive = fakeArchive({ fail: true });
  const state: { down: boolean; code?: string } = { down: true };
  const queuePending = archive.queuePending.bind(archive);
  archive.queuePending = (placeId, entries, opts) =>
    state.down
      ? Promise.reject(Object.assign(new Error('disk full'), state.code ? { code: state.code } : {}))
      : queuePending(placeId, entries, opts);
  archive.append = (placeId, entries, opts = {}) => {
    archive.appended.push({ placeId, entries, opts });
    return archive.fail
      ? Promise.reject(new Error('refused'))
      : Promise.resolve({ written: entries.length, duplicates: 0 });
  };
  return { archive, state };
}

test('store: when even the pending queue refuses, the victims wait in memory and the next drain archives them', async () => {
  const { archive, state } = brokenArchive();
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const hot = () => episodePlaces(store.getParticipation(placeOfRoot(store, 'g1')).episodes);
  participateAt(store, 'c1', 0);
  participateAt(store, 'c2', 10);
  const { logs } = await withCapturedLogs(async () => {
    participateAt(store, 'c3', 20);
    await storeSettle();
    state.code = 'ENOSPC';
    participateAt(store, 'c4', 30);
    await storeSettle();
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg.startsWith('store: archive')).map((entry) => [entry.msg, entry.code]),
    [
      ['store: archive failed', null],
      ['store: archive queue failed', null],
      ['store: archive failed', null],
      ['store: archive queue failed', 'ENOSPC'],
    ]
  );
  assert.deepEqual(archive.pending, []);
  assert.deepEqual(hot(), ['c1', 'c2', 'c3', 'c4']);

  archive.fail = false;
  state.down = false;
  assert.deepEqual(await store.drainArchive(), { archived: 0, left: 0 });
  assert.equal(archive.appended.at(-1)?.entries.length, 2, 'the waiting entries are appended');
  assert.deepEqual(hot(), ['c3', 'c4']);
  assert.deepEqual(
    await createStore(memoryAt(storeTmpDataDir())).drainArchive(),
    { archived: 0, left: 0 },
    'no archive'
  );
});

test('store: a paused store trims nothing, and a unit a hand edit broke in the pause keeps its items', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ manual: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const hot = () => episodePlaces(store.getParticipation(placeOfRoot(store, 'g1')).episodes);
  participateAt(store, 'c1', 0);
  participateAt(store, 'c2', 10);
  // Two writes of one tick: their victims share one background append.
  participateAt(store, 'c3', 20);
  participateAt(store, 'c4', 30);
  await storeSettle();
  assert.equal(archive.appended.length, 1);
  const { data } = store.state;
  data.paused = true;
  archive.releases.shift()?.();
  await storeSettle();
  assert.deepEqual(hot(), ['c1', 'c2', 'c3', 'c4'], 'paused: nothing trimmed');
  const { data: dataValue } = store.state;
  dataValue.paused = false;
  assert.deepEqual(await store.drainArchive(), { archived: 0, left: 0 });
  assert.deepEqual(hot(), ['c3', 'c4'], 'the resume trims what the archive confirmed');

  // A hold whose unit a hand edit replaced in a pause: nothing to trim, nothing thrown.
  participateAt(store, 'c5', 40);
  store.flush();
  await store.flushSettled({});
  const { data: dataValue3 } = store.state;
  dataValue3.paused = true;
  store.dropCaches();
  await storeWriteRaw(path.join(dir, 'guilds', 'g1', 'participation.json'), [{ id: 'p1' }]);
  const { data: dataValue4 } = store.state;
  dataValue4.paused = false;
  archive.releases.shift()?.();
  await storeSettle();
  assert.deepEqual(hot(), []);
  assert.ok(
    archive.appended.every((call) => call.entries.length > 0),
    'a chain link whose entries went with an earlier one appends nothing'
  );
});

test('store: an episode the next write keeps is released, so its confirmation trims nothing', async () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const g1 = placeOfRoot(store, 'g1');
  participateAt(store, 'c1', 0);
  participateAt(store, 'c2', 10);
  participateAt(store, 'c3', 20);
  // The cap raised: the held episode ranks again.
  store.setParticipation(g1, store.getParticipation(g1), {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 5 },
    now: PART_AT + 20 * PART_MIN,
  });
  await storeSettle();
  archive.releases.shift()?.();
  await storeSettle();
  assert.deepEqual(episodePlaces(store.getParticipation(g1).episodes), ['c1', 'c2', 'c3']);
});

test('store: a held episode goes back where it stood among the ones kept', async () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const g1 = placeOfRoot(store, 'g1');
  const write = (state: unknown, minute: number, maxStored: number) =>
    store.setParticipation(g1, state, {
      settings: { ...PARTICIPATION_DEFAULTS, maxStored },
      now: PART_AT + minute * PART_MIN,
    });
  write(partState(partState(emptyParticipation(), { placeId: 'c1', minute: 0 }), { placeId: 'c2', minute: 3 }), 3, 5);
  // c1 speaks again within its episode, so c2 is the oldest when c3 comes: the victim stood after the one kept.
  let state = partState(store.getParticipation(g1), { placeId: 'c1', minute: 8 });
  state = partState(state, { placeId: 'c3', minute: 12 });
  write(state, 12, 2);
  assert.deepEqual(episodePlaces(store.getParticipation(g1).episodes), ['c1', 'c2', 'c3']);
  // Every stored episode leaves for one new one: they go back first, in their order.
  write(partState(store.getParticipation(g1), { placeId: 'c4', minute: 16 }), 16, 1);
  assert.deepEqual(episodePlaces(store.getParticipation(g1).episodes), ['c1', 'c2', 'c3', 'c4']);
});

test('store: participation without settings or a clock expires by the defaults and the wall clock', async () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const g1 = placeOfRoot(store, 'g1');
  const { dropped } = store.setParticipation(g1, partState(emptyParticipation(), { placeId: 'c1', minute: 0 }));
  assert.deepEqual(
    dropped.map((episode) => asRecord(episode).placeId),
    ['c1'],
    'an episode of 2026 is past 72 hours of the wall clock'
  );
  await storeSettle();
  const firstAppended = archive.appended[0];
  assert.equal(asRecord(firstAppended.entries[0]).event, 'expired');
});

test('store: the diary holds an evicted post for the archive and lets a broken one go', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ manual: true });
  await storeWriteRaw(path.join(dir, 'guilds', 'g1', 'diary.json'), {
    posts: ['σπασμένο', { gist: 'παλιό' }],
    updatedAt: 1,
  });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const post = (gist: string) => ({ at: ID_NOW, kind: null, gist, picture: null, messageIds: [], search: '' });
  const { dropped } = store.appendDiaryPost(post('νέο'), { max: 1, now: ID_NOW });
  assert.deepEqual(dropped.length, 2);
  assert.deepEqual(
    store.getDiary().posts.map((p) => asRecord(p).gist),
    ['παλιό', 'νέο'],
    'the post without an object shape goes at once, the other waits for the archive'
  );
  await storeSettle();
  const firstAppended = archive.appended[0];
  assert.deepEqual(
    firstAppended.entries.map((entry) => [asRecord(entry).itemKind, asRecord(entry).event, asRecord(entry).scope]),
    [['diary', 'evicted', {}]]
  );
});

test('store: a diary backfill longer than the history holds what it cannot keep after the posts it keeps', () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const post = (gist: string) => ({ at: ID_NOW, kind: null, gist, picture: null, messageIds: [], search: '' });
  store.setDiaryPosts([post('α'), post('β'), post('α'), post('γ')], { max: 2 });
  assert.deepEqual(
    store.getDiary().posts.map((p) => asRecord(p).gist),
    ['α', 'γ', 'β'],
    'a post the kept ones repeat is not held twice'
  );
  assert.ok(store.getDiary().updatedAt > 0, 'stamped with the wall clock');
});

test('store: a hand edit that left the diary as a list reads as an empty diary; the default history is 150 posts', async () => {
  const { dir, memoryDb } = memDataDir();
  await storeWriteRaw(path.join(dir, 'guilds', 'g1', 'diary.json'), [{ gist: 'χαμένο' }]);
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.getDiary(), { posts: [], updatedAt: 0 });
  const post = (n: number) => ({ at: n, kind: null, gist: `${n}`, picture: null, messageIds: [], search: '' });
  store.setDiaryPosts(Array.from({ length: 151 }, (_, n) => post(n)));
  assert.deepEqual([store.getDiary().posts.length, asRecord(store.getDiary().posts[0]).gist], [150, '1']);
});

test('setLore: with the archive on, the version past 20 waits for its copy', async () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  for (let n = 0; n <= 21; n += 1)
    store.setLore(placeOfRoot(store, 'g1'), lore(`Κείμενο ${n}.`), { source: 'owner', by: 'owner', now: n });
  await storeSettle();
  const firstAppended = archive.appended[0];
  assert.deepEqual(
    firstAppended.entries.map((entry) => [
      asRecord(entry).itemKind,
      asRecord(entry).event,
      asRecord(entry).scope,
      asRecord(asRecord(entry).text).text,
    ]),
    [['version', 'evicted', { place: placeOfRoot(store, 'g1') }, 'Κείμενο 0.']]
  );
});

test('decayAffinities passes over a profile whose affinity a hand edit broke', async () => {
  const { dir, memoryDb } = memDataDir();
  storeWriteRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', affinity: 'φίλη' });
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.decayAffinities(DECAY_NOW, DECAY_CFG), { profiles: 1, decayed: 0 });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity, 'φίλη');
});

test('flushSettled: the shutdown waits at most timeoutMs; a store without a writer waits for nothing', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  assert.deepEqual(await store.flushSettled({ final: true, timeoutMs: 5000 }), { written: 1, failed: 0, waiting: 0 });
  const readOnly = createStore({ dataDir: dir, memoryDb: { readHandle: () => memoryDb.readHandle() } });
  assert.deepEqual(await readOnly.flushSettled({}), { written: 0, failed: 0 });
});

test('validate names the vault and the operational files of a place, never another file', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const broken = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '{ σπασμένο');
  };
  for (const rel of [
    'vault/key.json',
    'places/g1/journal/requests/r1.json',
    'places/g1/backfill/c1.json',
    'places/g1/record/backfill.json',
    'places/g1/private/u1/state.json',
    'places/g1/notes.json',
    'other/state.json',
    'places/g1/participation.json',
  ])
    broken(rel);
  fs.mkdirSync(path.join(dir, 'locked'));
  fs.chmodSync(path.join(dir, 'locked'), 0);
  try {
    assert.deepEqual(store.validate().sort(), [
      'places/g1/backfill/c1.json',
      'places/g1/journal/requests/r1.json',
      'places/g1/private/u1/state.json',
      'places/g1/record/backfill.json',
      'vault/key.json',
    ]);
  } finally {
    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  }
});

test('restoreArchived: a self list a hand edit left with a hole still takes a fact back', async () => {
  const { dir, memoryDb } = memDataDir();
  await storeWriteRaw(path.join(dir, 'guilds', 'g1', 'guild.json'), { self: [null, { text: 'πίνω τσάι' }] });
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  assert.deepEqual(store.restoreArchived(g1, { itemKind: 'selfFact', itemId: 'sf-1', text: { text: 'Πίνω τσάι' } }), {
    restored: false,
    reason: 'hot',
  });
  assert.equal(
    store.restoreArchived(g1, { itemKind: 'selfFact', itemId: 'sf-2', text: { text: 'παίζω κιθάρα' } }).restored,
    true
  );
});

test('store: a held post rewritten before its copy is confirmed stays until its new version is archived', async () => {
  const archive = fakeArchive({ manual: true });
  const store = createStore({ ...memoryAt(storeTmpDataDir()), newId: counterIds(), archive });
  const post = (gist: string) => ({ at: ID_NOW, kind: null, gist, picture: null, messageIds: [], search: '' });
  store.setDiaryPosts([post('παλιό')], { max: 5 });
  store.appendDiaryPost(post('νέο'), { max: 1 });
  await storeSettle();
  // The diary marks its posts again, so the held one comes back changed and leaves once more.
  const [held, kept] = store.getDiary().posts;
  store.setDiaryPosts([{ ...held, gist: 'παλιό, σημειωμένο' }, kept], { max: 1 });
  await storeSettle();
  archive.releases.shift()?.();
  await storeSettle();
  assert.deepEqual(
    store.getDiary().posts.map((p) => asRecord(p).gist),
    ['νέο', 'παλιό, σημειωμένο'],
    'the confirmed copy is of the old text: the new one stays, after the kept post'
  );
  archive.releases.shift()?.();
  await storeSettle();
  assert.deepEqual(
    store.getDiary().posts.map((p) => asRecord(p).gist),
    ['νέο']
  );
});

// Tests for the rule that links never reach the persona's stored memory:
// src/memory/clamp.ts#stripUrls, and every write point of the store that runs it
// (the lorebook, the archive and its restore, and the owner's ops).

const STORED_LINKS_URL = 'https://example.com/a?b=1&c=2#d';

function tmpStore() {
  return createStore(memoryAt(tempDir('nep-links-')));
}
describe('stored links', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    stopOwners = [ownedBy(['42'])];
  });
  after(() => {
    for (const stop of stopOwners) stop();
  });

  // ---- the lorebook ----

  test('setLore: title, keys and text are stored without links; a text that is only a link is no entry', () => {
    const store = tmpStore();
    const upserted = store.setLore(
      placeOfRoot(store, 'g1'),
      [
        {
          title: `Ο βράχος ${STORED_LINKS_URL}`,
          keys: ['βράχος', STORED_LINKS_URL],
          text: `Ένα αστείο του server ${STORED_LINKS_URL}.`,
        },
        { title: 'Κενό', keys: ['κενό'], text: STORED_LINKS_URL },
      ],
      { source: 'analyzer', by: 'analyzer', now: 1000 }
    );
    assert.equal(upserted, 1);
    const [entry] = store.getLore(placeOfRoot(store, 'g1'));
    assert.equal(asRecord(entry).title, 'Ο βράχος');
    assert.deepEqual(asRecord(entry).keys, ['βράχος']);
    assert.equal(asRecord(entry).text, 'Ένα αστείο του server.');
  });

  // ---- the archive ----

  test('restoreArchived: an item restored from an old archive line comes back without links', () => {
    const store = tmpStore();
    store.touchUser(accountOf(store, 'u1'), 'Ελένη', 1000);
    const entry = {
      itemKind: 'detail',
      itemId: 'dt-9',
      scope: { user: accountOf(store, 'u1') },
      text: { text: `παίζει πιάνο ${STORED_LINKS_URL}` },
      stored: { id: 9, firstSeen: '2026-10-01T00:00:00.000Z' },
      weight: 1,
    };
    const result = store.restoreArchived(placeOfRoot(store, 'g1'), entry);
    assert.equal(result.restored, true);
    assert.equal(
      asRecord(store.getUser(accountOf(store, 'u1'))).details.find((d: Untyped) => d.itemId === 'dt-9').text,
      'παίζει πιάνο'
    );
    const self = store.restoreArchived(placeOfRoot(store, 'g1'), {
      itemKind: 'selfFact',
      itemId: 'sf-1',
      scope: { guild: true },
      text: { text: STORED_LINKS_URL },
    });
    assert.equal(self.restored, false, 'a self fact that is only a link is not restored');
  });
});
