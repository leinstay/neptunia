// The store reads its values from the memory database and writes each change to it at the end of the tick that made
// it (src/memory/store.ts, src/memory/store-writes.ts): a second reader sees a change without a flush, the store sees a
// change another writer made, a read during a write under way returns the change, and the shutdown's flush waits for
// the writes under way, at most `timeoutMs`, logging what it left. Synthetic data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { onLog } from '../../../src/log.ts';
import { accountOf } from '../../../src/memory/addresses.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { createStore } from '../../../src/memory/store.ts';
import { ANNA, seedOpaqueWorld } from '../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { writeUnitUpdate } from '../../fixtures/memory-db/unit-writes.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

const A = 'place:room-1';
const LINE_AT = '2026-11-02T10:00:00.000Z';
const LORE_OPTIONS = {
  source: 'owner',
  by: 'owner',
  now: 1000,
  maxEntries: 10,
  textChars: 400,
  clampTolerance: 0,
};
const loreEntry = (title: string) => ({ title, keys: ['synthetic'], text: `about ${title}`, always: false });

/** A memory service over the opaque people's world, open, with its writer on this thread. */
function service(): MemoryDbService {
  const dataDir = tempDir('nep-store-direct-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  // One line Anna said in the room, for the session's evidence.
  dbOf(seed)
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text,
       direct, scope_kind, scope_iface, scope_dm) VALUES ('src:line-1', 'seen', 'discord', 'line-1', 1, ?, 'account:a11',
       ?, ?, 'a synthetic line', 0, 'group', 'discord', NULL)`
    )
    .run(A, LINE_AT, LINE_AT);
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
  return memoryDb;
}

/** The service with its lorebook writes held until `release()`; `never` holds them for good. */
function gated(memoryDb: MemoryDbService, { never = false } = {}) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: MemoryDbService = {
    ...memoryDb,
    writePlaceLore: async (write) => {
      await (never ? new Promise<void>(() => {}) : gate);
      return memoryDb.writePlaceLore(write);
    },
  };
  return { held, release };
}

const titles = (lore: Array<object>): Array<unknown> => lore.map((entry): unknown => Reflect.get(entry, 'title'));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a lorebook the store set is in the database at the end of the tick, with no flush', async () => {
  // Bug: a change waited up to the flush timer in memory, so a crash before it lost what the persona learned.
  const memoryDb = service();
  const store = createStore({ dataDir: tempDir('nep-store-direct-a-'), memoryDb });
  store.setLore(A, [loreEntry('Η αποβάθρα')], LORE_OPTIONS);
  await tick();
  const other = createStore({ dataDir: tempDir('nep-store-direct-b-'), memoryDb });
  assert.deepEqual(titles(other.getLore(A)), ['Η αποβάθρα']);
});

test('the store reads a lorebook another writer changed after its own read', async () => {
  // Bug: a value read once was served from memory, so a write of another writer stayed unseen until a restart.
  const memoryDb = service();
  const store = createStore({ dataDir: tempDir('nep-store-direct-a-'), memoryDb });
  assert.deepEqual(store.getLore(A), []);
  // The console writes a unit through the writer, as any writer other than the store does.
  await writeUnitUpdate(memoryDb, {
    op: 'value',
    key: { kind: 'lore', subject: { type: 'place', id: A } },
    value: [loreEntry('Le phare')],
  });
  assert.deepEqual(titles(store.getLore(A)), ['Le phare']);
});

test("a store's next change keeps a lorebook entry a second store wrote since its read", async () => {
  // Bug: the service counted no direct write for `writeGeneration`, because the store's own writes take that path, so a
  // store answered from its last read after a second store over the same service wrote the unit, and its next change
  // wrote that stale copy back over the second store's write.
  const memoryDb = service();
  const first = createStore({ dataDir: tempDir('nep-store-direct-a-'), memoryDb });
  const second = createStore({ dataDir: tempDir('nep-store-direct-b-'), memoryDb });
  assert.deepEqual(first.getLore(A), []);
  second.setLore(A, [loreEntry('Le phare')], LORE_OPTIONS);
  await second.flushSettled({});
  first.setLore(A, [...first.getLore(A), loreEntry('Η αποβάθρα')], LORE_OPTIONS);
  await first.flushSettled({});
  const reader = createStore({ dataDir: tempDir('nep-store-direct-c-'), memoryDb });
  assert.deepEqual(titles(reader.getLore(A)), ['Le phare', 'Η αποβάθρα']);
});

test("a store's next change keeps a profile field another writer wrote through the direct write", async () => {
  // Bug: a direct `writeAccountProfile` of a writer other than the store moved no `writeGeneration`, so the store's
  // next `touchUser` changed its last read and wrote the profile back without the other writer's field.
  const dataDir = tempDir('nep-store-direct-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  dbOf(seed)
    .prepare(
      "INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES ('discord:111', 'discord', '111', '111', 'user')"
    )
    .run();
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const account = accountOf(store, '111');
  store.touchUser(account, 'Alice', 1000);
  await store.flushSettled({});
  const own = { ...(store.getUser(account) as Record<string, unknown>) };
  delete own.personId;
  delete own.accounts;
  await memoryDb.writeAccountProfile({ accountId: account, value: { ...own, character: 'chatty' } });
  store.touchUser(account, 'Alice', 2000);
  await store.flushSettled({});
  const reader = createStore({ dataDir, memoryDb });
  assert.equal((reader.getUser(account) as { character?: string }).character, 'chatty');
});

test('a read while the write of a change is still under way returns the change', async () => {
  const memoryDb = service();
  const { held, release } = gated(memoryDb);
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: held });
  store.setLore(A, [loreEntry('Η αποβάθρα')], LORE_OPTIONS);
  await tick();
  assert.deepEqual(titles(store.getLore(A)), ['Η αποβάθρα']);
  release();
  await store.flushSettled({});
  assert.deepEqual(titles(store.getLore(A)), ['Η αποβάθρα']);
});

test('the shutdown flush waits for a write under way and returns once it landed', async () => {
  // Bug: the shutdown closed the database under a write that had not landed, and the change was lost.
  const memoryDb = service();
  const { held, release } = gated(memoryDb);
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: held });
  store.setLore(A, [loreEntry('Le phare')], LORE_OPTIONS);
  let done = false;
  const settling = store.flushSettled({ final: true, timeoutMs: 5000 }).then((counts) => {
    done = true;
    return counts;
  });
  await tick();
  await tick();
  assert.equal(done, false);
  release();
  assert.equal((await settling).waiting, 0);
  const other = createStore({ dataDir: tempDir('nep-store-direct-b-'), memoryDb });
  assert.deepEqual(titles(other.getLore(A)), ['Le phare']);
});

test('the shutdown flush stops waiting after timeoutMs and logs the writes still under way', async () => {
  // Bug: a write that never answered held the shutdown forever, or was dropped without a line in the log.
  const memoryDb = service();
  const { held } = gated(memoryDb, { never: true });
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: held });
  const lines: Array<Record<string, unknown>> = [];
  const stop = onLog((entry) => lines.push(entry));
  try {
    store.setLore(A, [loreEntry('Le phare')], LORE_OPTIONS);
    const timer = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000).unref());
    const counts = await Promise.race([store.flushSettled({ final: true, timeoutMs: 50 }), timer]);
    assert.notEqual(counts, 'hung');
    assert.equal(typeof counts === 'object' ? counts.waiting : null, 1);
    const line = lines.find((entry) => entry.msg === 'store: writes still under way at shutdown');
    assert.equal(line?.units, 1);
    assert.equal(line?.ms, 50);
  } finally {
    stop();
  }
});

/** The service with its profile writes held until `release()`. */
function gatedProfiles(memoryDb: MemoryDbService) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: MemoryDbService = {
    ...memoryDb,
    writeAccountProfile: async (write) => {
      await gate;
      return memoryDb.writeAccountProfile(write);
    },
  };
  return { held, release };
}

/** The persona's memory session adds one detail about Anna in the group scope of discord, from one seeded line. */
function sessionAddsDetail(memoryDb: MemoryDbService, text: string): Promise<unknown> {
  const at = LINE_AT;
  const now = Date.parse(at);
  return memoryDb.memoryWrite({
    kind: 'session',
    mode: 'apply',
    now,
    maxDelta: 5,
    run: {
      id: 'run:cross',
      sweepId: 'sweep:cross',
      scopeKey: 'group:discord',
      scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
      batchKey: 'cross',
      startedAt: at,
      finishedAt: at,
      cursorFrom: 0,
      cursorTo: 1,
      sourcesN: 1,
      outcome: 'ok',
      counts: {},
      errors: [],
    },
    plan: {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: ANNA,
          kind: 'detail',
          text,
          how: 'said',
          sources: ['src:line-1'],
          when: null,
        },
      ],
      episodes: [],
      descriptions: [],
      affinity: [],
    },
  });
}

const detailTexts = (profile: unknown): Array<unknown> =>
  ((Reflect.get(Object(profile), 'details') as Array<object> | undefined) ?? []).map((item): unknown =>
    Reflect.get(item, 'text')
  );

test('a detail the session of the persona adds while a profile change waits for its write is read once the change landed', async () => {
  // Bug: the store answered its next read with the profile it had sent, so the session's new detail stayed hidden
  // from the turn until a restart.
  const memoryDb = service();
  const plain = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb });
  plain.touchUser('account:a11', 'Anna', Date.parse('2026-11-02T09:00:00.000Z'));
  await plain.flushSettled({});
  const { held, release } = gatedProfiles(memoryDb);
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: held });
  store.touchUser('account:a11', 'Anna', Date.parse('2026-11-02T10:00:00.000Z'));
  await tick();
  // A second change waits behind the first write, so the profile stays in use while the persona's session writes.
  store.touchUser('account:a11', 'Anna', Date.parse('2026-11-02T11:00:00.000Z'));
  await tick();
  await sessionAddsDetail(memoryDb, 'Ο φάρος είναι δικός της');
  release();
  await store.flushSettled({});
  assert.ok(detailTexts(store.getUser('account:a11')).includes('Ο φάρος είναι δικός της'));
});

/** The service whose lorebook writes fail while `down()` is true. */
function failingLore(memoryDb: MemoryDbService, down: () => boolean): MemoryDbService {
  return {
    ...memoryDb,
    writePlaceLore: (write) =>
      down() ? Promise.reject(Object.assign(new Error('down'), { code: 'DB_CLOSED' })) : memoryDb.writePlaceLore(write),
  };
}

test('a change whose write failed stays in the store and the next flush writes it', async () => {
  // Bug: a failed write was dropped with the value, so what the persona learned was gone at the next read.
  const memoryDb = service();
  let down = true;
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: failingLore(memoryDb, () => down) });
  store.setLore(A, [loreEntry('Le phare')], LORE_OPTIONS);
  await store.flushSettled({});
  assert.deepEqual(titles(store.getLore(A)), ['Le phare']);
  down = false;
  store.flush();
  await store.flushSettled({});
  const other = createStore({ dataDir: tempDir('nep-store-direct-b-'), memoryDb });
  assert.deepEqual(titles(other.getLore(A)), ['Le phare']);
});

test('the shutdown flush logs as lost a change whose write still fails', async () => {
  const memoryDb = service();
  const store = createStore({ dataDir: tempDir('nep-store-direct-'), memoryDb: failingLore(memoryDb, () => true) });
  const lines: Array<Record<string, unknown>> = [];
  const stop = onLog((entry) => lines.push(entry));
  try {
    store.setLore(A, [loreEntry('Le phare')], LORE_OPTIONS);
    const counts = await store.flushSettled({ final: true, timeoutMs: 5000 });
    assert.equal(counts.waiting, 1);
    const lost = lines.find((entry) => entry.msg === 'memory db: units lost');
    assert.equal(lost?.units, 1);
    assert.equal(lost?.code, 'DB_CLOSED');
  } finally {
    stop();
  }
});
