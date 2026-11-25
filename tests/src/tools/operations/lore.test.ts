import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdmin, makeRoot } from '../../../fixtures/admin-rig.ts';
import { placeOfRoot } from '../../../../src/memory/addresses.ts';
import path from 'node:path';
import { createStore } from '../../../../src/memory/store.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { asRecord } from '../../../fixtures/records.ts';
import { memoryAt } from '../../../fixtures/store-kit.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import fs from 'node:fs';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { addAccount, addAuthority, addDmPlace } from '../../../fixtures/memory-db/opaque-people.ts';

// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.

// ---------------------------------------------------------------------------
// lore: add / list / show / remove
// ---------------------------------------------------------------------------

test('run: lore.add saves an owner entry, splitting comma-separated keys', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run(
    'lore.add',
    { title: 'Founders Day', keys: ' founders , founding day ', text: 'The server was founded then.' },
    { placeId: 'g1' }
  );

  assert.ok(result.includes('Founders Day'));
  const [entry] = store.getLore('g1');
  assert.equal(entry.title, 'Founders Day');
  assert.deepEqual(entry.keys, ['founders', 'founding day']);
  assert.equal(entry.source, 'owner');
});

test('run: lore.add overwrites an existing analyzer entry and it becomes an owner entry', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer text' }], {
    source: 'analyzer',
    now: 1000,
  });

  await admin.run(
    'lore.add',
    { title: 'Founders Day', keys: 'founders', text: 'owner text', always: true },
    { placeId: 'g1' }
  );

  const [entry] = store.getLore('g1');
  assert.equal(entry.text, 'owner text');
  assert.equal(entry.source, 'owner');
  assert.equal(entry.always, true);
});

test('run: lore.remove deletes an entry by id and reports its title', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded.' }], {
    source: 'analyzer',
    now: 1000,
  });
  const [{ id }] = store.getLore('g1');

  const result = await admin.run('lore.remove', { id }, { placeId: 'g1' });
  assert.ok(result.includes('The Flood'));
  assert.deepEqual(store.getLore('g1'), []);
});

// Tests for the rule that links never reach the persona's stored memory:
// src/memory/clamp.ts#stripUrls, and every write point of the store that runs it
// (the lorebook, the archive and its restore, and the owner's ops).

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const STORED_LINKS_URL = 'https://example.com/a?b=1&c=2#d';

function tmpStore() {
  return createStore(memoryAt(tempDir('nep-links-')));
}

// ---- the owner's ops (and the persona's skills that run them) ----

function opsEnv(store: ReturnType<typeof tmpStore>) {
  const rootDir = tempDir('nep-links-ops-');
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON },
      llm: { model: 'x/y', maxRequestsPerDay: 10 },
      memory: { confirmAfter: 2 },
      lore: {},
    },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
  });
}
describe('stored links', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    stopOwners = [ownedBy(['42'])];
  });
  after(() => {
    for (const stop of stopOwners) stop();
  });

  // Changed: lore.add alone, since learning.add and alias.add left with their commands.
  test('ops lore.add: what it stores holds no link', async () => {
    const store = tmpStore();
    const ctx = { env: opsEnv(store), placeId: 'g1', accountId: '42', roleIds: [] };
    await runOp(
      'lore.add',
      {
        title: `Ο βράχος ${STORED_LINKS_URL}`,
        keys: `βράχος, ${STORED_LINKS_URL}`,
        text: `Το αστείο ${STORED_LINKS_URL}`,
      },
      ctx
    );
    const [entry] = store.getLore('g1');
    assert.deepEqual(
      [asRecord(entry).title, asRecord(entry).keys, asRecord(entry).text],
      ['Ο βράχος', ['βράχος'], 'Το αστείο']
    );
  });

  test('ops lore.add: a text that is only a link is refused and stores nothing', async () => {
    const store = tmpStore();
    const ctx = { env: opsEnv(store), placeId: 'g1', accountId: '42', roleIds: [] };
    const result = await runOp('lore.add', { title: 'Κενό', keys: 'κενό', text: STORED_LINKS_URL }, ctx);
    assert.notEqual(asRecord(result).ok, true);
    assert.deepEqual(store.getLore(placeOfRoot(store, 'g1')), []);
  });
});

// A tool takes the place it runs in and nothing else: `OpContext.placeId` is the channel, the thread or the DM of the
// call, and an operation on what a whole tree shares asks `store.rootPlaceOf(placeId)` for its top (plan 2026-11-05 T.4
// and B0.2). The lorebook is such a collection: `lore.add` from any channel of a server writes it under the server, and a
// DM is the top of its own tree. No context here carries a second, top place, so a write under the top proves the lookup.

const SERVER = 'place:server-1';
const CHANNEL = 'place:channel-1';
const OTHER_CHANNEL = 'place:channel-2';
const THREAD = 'place:thread-1';
const DM = 'place:dm-1';

const opened: Array<MemoryDbService> = [];

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
describe('the root of a place', () => {
  after(async () => {
    for (const service of opened) await service.close();
  });

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
});
