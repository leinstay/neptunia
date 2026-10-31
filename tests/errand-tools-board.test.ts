// Her errand tools (src/tools/impl/errand.ts) over the board (PR 6d): `errand.status`, `errand.list`, `errand.read`,
// `errand.resolve` and `errand.cancel` answer over errands moved from the `work` archive exactly as they answer over
// the same errands kept in memory, and `errand.run` and `errand.cancel` write the board. The errand client is a fake
// the test ends by hand; the memory service is the real one on the calling thread. Temporary data directories, a
// fixed clock.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { readBoard } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import type { Obj } from '../src/tools/types.ts';
import type { ErrandClient, ErrandService, ErrandStores, RunOutcome } from '../src/errands/types.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { openTestMemorySync } from './fixtures/memory-db/service.js';
import { writeArchive } from './fixtures/errand-archive.ts';
import { tempDir } from './fixtures/tmp.js';

const OWNER = '42';
const MEMBER = '7';
const NOW = Date.parse('2026-10-31T09:00:00.000Z');
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type MemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];
type Answer = { status: string; code: string; summary: string; data: unknown };
type Env = ReturnType<typeof createOpsEnv>;

const OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of OPENED) await memory.close();
});

/** A fake errand client: each run waits until the test ends it (or a cancel does). */
function fakeClient(): Partial<ErrandClient> & { end: (id: string, outcome: Partial<RunOutcome>) => void } {
  const gates = new Map<string, (outcome: RunOutcome) => void>();
  const outcome = (given: Partial<RunOutcome>): RunOutcome => ({
    status: given.status ?? 'failed',
    result: given.result ?? { text: '', sources: [], files: [] },
    usage: given.usage ?? { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
    ...(given.error ? { error: given.error } : {}),
  });
  return {
    configured: () => true,
    run: (request) => new Promise<RunOutcome>((resolve) => gates.set(request.id, resolve)),
    cancel: (request) => {
      gates.get(request.id)?.(outcome({ status: 'cancelled', error: 'cancelled' }));
      return true;
    },
    end: (id, given) => gates.get(id)?.(outcome(given)),
  };
}

type Rig = { env: Env; client: ReturnType<typeof fakeClient>; errands: ErrandService; stores: ErrandStores };

/** The ops of the errand tools over stores on `memoryDb` (null: the errands kept in memory only). */
function makeEnv(memoryDb: MemoryDb | null): Rig {
  const hot = {
    config: {
      bot: { owners: [OWNER], access: {} },
      features: {},
      errands: { maxOpen: 3, resultMaxChars: 40 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: true, daily: { tasks: 10 } } },
    },
    prompts: { labels: {} },
    rootDir: tempDir('nep-errand-tools-board-'),
    reloadConfig: () => true,
  };
  const client = fakeClient();
  const stores = createErrandStores({ config: () => hot.config, now: () => NOW, log: SILENT, memoryDb });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', now: () => NOW, log: SILENT });
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    errands,
    now: () => NOW,
  });
  return { env, client, errands, stores };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What an answer says: its status, code, summary and data. */
async function ask(env: Env, name: string, args: Obj, userId: string = MEMBER): Promise<Answer> {
  const { status, code, summary, data } = await runOp(name, args, {
    env,
    guildId: 'g1',
    channelId: 'c1',
    userId,
    roleIds: [],
  });
  return { status, code, summary, data };
}

/** The id of the errand an `errand.run` answer names. */
function idOf(answer: Answer): string {
  const data = answer.data;
  const task = data !== null && typeof data === 'object' && 'task' in data ? data.task : null;
  const id = task !== null && typeof task === 'object' && 'id' in task ? task.id : null;
  if (typeof id !== 'string') throw new Error(`no errand id in ${answer.summary}`);
  return id;
}

/** The board as the read connection of `memoryDb` shows it. */
function boardOf(memoryDb: MemoryDb): ReturnType<typeof readBoard> {
  // service.js types its read handle loosely; it is open.js's handle, `{ db }`, or null while the database is closed.
  const handle = memoryDb.readHandle() as { db: object } | null;
  if (!handle) throw new Error('the memory database is not open');
  // The connection is node:sqlite's DatabaseSync, which has every method BoardDb names.
  return readBoard(handle.db as BoardDb, () => NOW);
}

/** A memory service over a new data directory, written first by `prepare` when given. */
function openedAt(prefix: string, prepare: ((file: string) => void) | null = null): MemoryDb {
  const dataDir = path.join(tempDir(prefix), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  prepare?.(path.join(dataDir, 'memory.db'));
  const opened = openTestMemorySync({ dataDir, now: () => NOW, log: SILENT });
  OPENED.push(opened);
  return opened.memoryDb;
}

/** Three errands of the scout run in memory: one done with a result longer than a page, one failed, one open. */
async function inMemory(): Promise<{ memory: Rig; ids: Array<string> }> {
  const memory = makeEnv(null);
  const ids: Array<string> = [];
  for (const goal of ['find the release notes', 'compare the price lists', 'look up the opening hours']) {
    ids.push(idOf(await ask(memory.env, 'errand.run', { agent: 'scout', goal })));
  }
  await tick();
  memory.client.end(ids[0] ?? '', {
    status: 'done',
    result: {
      text: 'The notes list three changes, and the second one matters most of all.',
      sources: ['https://example.org/n'],
      files: [],
    },
    usage: { input: 900, output: 200, usd: 0.25, steps: 3, seconds: 4 },
  });
  memory.client.end(ids[1] ?? '', { status: 'failed', error: 'withheld-path' });
  await tick();
  return { memory, ids };
}

test('the errand tools answer over the moved errands as they answer over the same errands kept in memory', async () => {
  await withCapturedLogs(async () => {
    const { memory, ids } = await inMemory();
    const records = [...(memory.stores.get('g1')?.recent(10) ?? [])].reverse();
    const memoryDb = openedAt('nep-errand-tools-archive-', (file) => writeArchive(file, records));
    const board = makeEnv(memoryDb);
    assert.equal(boardOf(memoryDb).list().length, 3, 'the open moved them to the board');
    const asks: Array<[string, Obj]> = [
      ['errand.status', {}],
      ['errand.status', { id: ids[0] }],
      ['errand.list', {}],
      ['errand.read', { id: ids[0] }],
      ['errand.read', { id: ids[0], from: 40 }],
      ['errand.resolve', { id: ids[1] }],
      ['errand.status', {}],
    ];
    for (const [name, args] of asks) {
      assert.deepEqual(await ask(board.env, name, args), await ask(memory.env, name, args), `${name} ${ids.join(',')}`);
    }
  });
});

test('errand.run files the errand on the board as a scout task in progress once it is sent', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-run-');
    const { env, stores } = makeEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.run', { agent: 'scout', goal: 'find the changelog' }));
    await tick();
    await stores.flush();
    const { task } = boardOf(memoryDb).show(id);
    assert.deepEqual([task.lane, task.role, task.status], ['errand', 'scout', 'in_progress']);
  });
});

test('errand.cancel moves the board task to cancelled', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-cancel-');
    const { env, stores, errands } = makeEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.run', { agent: 'scout', goal: 'find the changelog' }));
    await tick();
    assert.equal((await ask(env, 'errand.cancel', { id })).status, 'ok');
    await errands.idle();
    await stores.flush();
    assert.equal(boardOf(memoryDb).show(id).task.status, 'cancelled');
  });
});
