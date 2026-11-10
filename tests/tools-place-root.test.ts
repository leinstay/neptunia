// A tool takes the place it runs in and nothing else: `OpContext.placeId` is the channel, the thread or the DM of the
// call, and an operation on what a whole tree shares asks `store.rootPlaceOf(placeId)` for its top (plan 2026-11-05 T.4
// and B0.2). The lorebook is such a collection: `lore.add` from any channel of a server writes it under the server, and a
// DM is the top of its own tree. No context here carries a second, top place, so a write under the top proves the lookup.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { runOp } from '../src/tools/operations/index.ts';
import { addAccount, addAuthority, addDmPlace } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const SERVER = 'place:server-1';
const CHANNEL = 'place:channel-1';
const OTHER_CHANNEL = 'place:channel-2';
const THREAD = 'place:thread-1';
const DM = 'place:dm-1';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function addPlace(db: Db, id: string, kind: string, parent: string | null): void {
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind, parent_id)
     VALUES (?, 'one', ?, ?, ?, 'one/global', 1, 'group', 'group', ?)`
  ).run(id, kind, id, `${kind}:${id}`, parent);
}

/** A server with two channels and a thread in the first, and a DM, each a stored place. */
function rig(): { env: ReturnType<typeof createOpsEnv>; store: ReturnType<typeof createStore> } {
  const dataDir = tempDir('nep-tools-place-root-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  addAuthority(db, 'one', 'one/global');
  addPlace(db, SERVER, 'server', null);
  addPlace(db, CHANNEL, 'channel', SERVER);
  addPlace(db, OTHER_CHANNEL, 'channel', SERVER);
  addPlace(db, THREAD, 'thread', CHANNEL);
  addAccount(db, { id: 'account:p1', iface: 'one', authority: 'one/global', native: 'p1', person: 'person:p1' });
  addDmPlace(db, { id: DM, iface: 'one', authority: 'one/global', account: 'account:p1', person: 'person:p1' });
  seed.close();
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const rootDir = tempDir('nep-tools-place-root-dir-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = createStore({ dataDir, memoryDb });
  return { env: createOpsEnv({ hot, store, memoryDb, dataDir }), store };
}

const at = (env: ReturnType<typeof createOpsEnv>, placeId: string) => ({ env, asOwner: true, placeId });
const entry = (title: string) => ({ title, keys: 'synthetic', text: `a synthetic fact of ${title}` });

async function titlesUnder(store: ReturnType<typeof createStore>, placeId: string): Promise<Array<unknown>> {
  store.flush();
  await store.flushSettled({});
  return store.getLore(placeId).map((one: object): unknown => Reflect.get(one, 'title'));
}

test('lore written from a channel lands under its server and not under the channel', async () => {
  // Bug: the tool writes under the place it was given, so each channel keeps its own lorebook and the server's is empty.
  const { env, store } = rig();
  const added = await runOp('lore.add', entry('from the channel'), at(env, CHANNEL));
  assert.equal(added.status, 'ok');
  assert.deepEqual(await titlesUnder(store, SERVER), ['from the channel']);
  assert.deepEqual(await titlesUnder(store, CHANNEL), []);
});

test('lore written from a thread lands under the server two levels up', async () => {
  // Bug: the top is taken as the parent, so a thread writes into its channel instead of the server.
  const { env, store } = rig();
  const added = await runOp('lore.add', entry('from the thread'), at(env, THREAD));
  assert.equal(added.status, 'ok');
  assert.deepEqual(await titlesUnder(store, SERVER), ['from the thread']);
  assert.deepEqual(await titlesUnder(store, CHANNEL), []);
  assert.deepEqual(await titlesUnder(store, THREAD), []);
});

test('lore written from a DM lands under the DM, the top of its own tree', async () => {
  // Bug: a DM with no parent is refused or falls back to a server, and a private fact joins a public lorebook.
  const { env, store } = rig();
  const added = await runOp('lore.add', entry('from the dm'), at(env, DM));
  assert.equal(added.status, 'ok');
  assert.deepEqual(await titlesUnder(store, DM), ['from the dm']);
  assert.deepEqual(await titlesUnder(store, SERVER), []);
});

test('lore written in one channel is listed in its sibling channel', async () => {
  // Bug: the read side takes the place as given while the write side climbs, so nobody ever reads the server's lore.
  const { env } = rig();
  await runOp('lore.add', entry('shared by the server'), at(env, CHANNEL));
  const listed = await runOp('lore.list', {}, at(env, OTHER_CHANNEL));
  assert.equal(listed.status, 'ok');
  assert.ok(JSON.stringify(listed).includes('shared by the server'));
});
