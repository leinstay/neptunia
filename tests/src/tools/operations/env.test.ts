// The console operations and the persona's tools on neutral contracts (src/tools/operations/env.ts and the families
// over it): an operation that addresses a place reads it from its context or its arguments. Nothing falls back to a
// home root, and a place operation with no place refuses with the code `PLACE_REQUIRED`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { makeAdmin, makeRoot } from '../../../fixtures/admin-rig.ts';
import { createHot as createHotUntyped } from '../../../../src/hot.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(): ReturnType<typeof createOpsEnv> {
  const dataDir = tempDir('nep-tools-neutral-');
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const rootDir = tempDir('nep-tools-neutral-root-');
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
  return createOpsEnv({ hot, store: createStore({ dataDir, memoryDb }), memoryDb, dataDir });
}

const owner = (env: ReturnType<typeof createOpsEnv>, placeId?: string) => ({
  env,
  asOwner: true,
  ...(placeId === undefined ? {} : { placeId }),
});

test('a place operation with a place in its context reads that place', async () => {
  // Bug: the context's place is ignored for the home root, so the owner reads the wrong server's lore.
  const env = rig();
  const added = await runOp(
    'lore.add',
    { title: 'of room one', keys: 'synthetic', text: 'a synthetic fact' },
    owner(env, 'place:room-1')
  );
  assert.equal(added.status, 'ok');
  const here = await runOp('lore.list', {}, owner(env, 'place:room-1'));
  assert.ok(JSON.stringify(here).includes('of room one'));
  const there = await runOp('lore.list', {}, owner(env, 'place:room-2'));
  assert.equal(JSON.stringify(there).includes('of room one'), false);
});

test('a place operation with no place is refused by name', async () => {
  // Bug: it falls back to a home root, or stores under an empty id that every such caller then shares.
  const result = await runOp('lore.list', {}, owner(rig()));
  assert.equal(result.code, 'PLACE_REQUIRED');
});

test('an operation of the persona needs no place at all', async () => {
  // Bug: `status.show` and the kill switch share the root prerequisite though they read no place.
  const result = await runOp('status.show', {}, owner(rig()));
  assert.equal(result.status, 'ok');
});

// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.

function clientWithGuild(placeId: string, name: string) {
  return { guilds: { cache: new Map([[placeId, { id: placeId, name }]]) } };
}

test('run: every command that writes data/ is refused while paused, with a hint to resume', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('bot.pause', {}, {});

  const attempts: Array<[string, Record<string, unknown>]> = [
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['message.create', {}],
  ];
  for (const [key, args] of attempts) {
    await assert.rejects(
      () => admin.run(key, args, { placeId: 'c1' }),
      /paused.*resume/i,
      `${key} must be refused while paused`
    );
  }
});

test('run: read-only and config commands keep working while paused', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });

  await admin.run('bot.pause', {}, {});

  await assert.doesNotReject(() => admin.run('status.show', {}, {}));
  await assert.doesNotReject(() => admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' }));
  await assert.doesNotReject(() => admin.run('lore.list', {}, { placeId: 'g1' }));
  await assert.doesNotReject(() => admin.run('model.show', {}, {}));
  await assert.doesNotReject(() => admin.run('rule.list', {}, {}));
  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `llm.maxRequestsPerDay` is the leaf here.
  await assert.doesNotReject(() => admin.run('config.set', { path: 'llm.maxRequestsPerDay', value: '250' }, {}));
  await assert.doesNotReject(() => admin.run('config.unset', { path: 'llm.maxRequestsPerDay' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'core', id: 'x/y' }, {}));
});

test('run: memory.show/lore.list/lore.show drop caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('bot.pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);

  await admin.run('lore.list', {}, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 2);

  await admin.run('lore.show', { id: loreId }, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 3);
});

// Canonical persona configuration and labels merge over engine defaults.
// Existing merge, targeted-write, watcher and interface precedence controls retain their values.

type Tree = Record<string, unknown>;

const BASE_CONFIG = { pace: { settleMs: 500, settleMaxMs: 3000 }, llm: { retries: 2 } };
const BASE_LABELS = {
  model: { transcript: { gap: 'base gap {duration}', edited: 'base edited' } },
  owner: { status: { costs: { keyLead: 'base lead' } } },
};

function write(dir: string, rel: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(value));
}

/** A checkout with only the new tracked files: config/config.json, config/labels.json and an empty prompts/. */
function checkout(): string {
  const dir = tempDir('nep-cfgdir-root-');
  write(dir, 'config/config.json', BASE_CONFIG);
  write(dir, 'config/labels.json', BASE_LABELS);
  fs.mkdirSync(path.join(dir, 'prompts'));
  return dir;
}

/** A canonical persona layer uses config/ for runtime reads, writes and watches. */
function movedLayer(): string {
  const dir = tempDir('nep-cfgdir-new-');
  write(dir, 'config/config.json', { pace: { settleMs: 900 } });
  write(dir, 'config/labels.json', {
    model: { transcript: { gap: 'my gap {duration}' } },
    owner: { status: { costs: { keyLead: 'my lead' } } },
  });
  return dir;
}

/** What these tests read of the live view (src/hot.ts). */
type Hot = {
  config: Tree;
  prompts: Record<string, unknown> & { labels: Tree };
  reloadConfig: () => boolean;
  reloadPrompts: () => boolean;
  onReload: (listener: (what: string) => void) => () => void;
  watch: () => Hot;
  close: () => void;
};

const createHot = (options: { rootDir: string; privateDir: string; watchImpl?: unknown }): Hot =>
  createHotUntyped({
    rootDir: options.rootDir,
    privateDir: options.privateDir,
    ...(options.watchImpl === undefined ? {} : { watchImpl: options.watchImpl as typeof fs.watch }),
  });

test('writes a setting into config/config.json in a canonical layer, and the live config has it', () => {
  const privateDir = movedLayer();
  const hot = createHot({ rootDir: checkout(), privateDir });
  try {
    const env = createOpsEnv({
      discord: createDiscordInterface().capabilities,
      hot,
      store: { state: { data: {}, markDirty() {} } },
    });
    assert.equal(env.writeLocalPath('llm.retries', 5), true);
    const written: unknown = JSON.parse(fs.readFileSync(path.join(privateDir, 'config', 'config.json'), 'utf8'));
    assert.deepEqual(written, { pace: { settleMs: 900 }, llm: { retries: 5 } });
    assert.equal(fs.existsSync(path.join(privateDir, 'config.local.json')), false, 'no old-place file is made');
    assert.equal((hot.config.llm as Tree).retries, 5);
  } finally {
    hot.close();
  }
});
