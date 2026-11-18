// Her errand tools (src/tools/operations/errand.ts) over the board (PR 6d): `errand.status`, `errand.list`, `errand.read`,
// `errand.resolve` and `errand.cancel` answer over errands moved from the `work` archive exactly as they answer over
// the same errands kept in memory, and `errand.scout` and `errand.cancel` write the board. The errand client is a fake
// the test ends by hand; the memory service is the real one on the calling thread. Temporary data directories, a
// fixed clock.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { boardTaskOf } from './fixtures/board-task.ts';
import type { BoardTask } from './fixtures/board-task.ts';
import type { Obj } from '../src/tools/types.ts';
import type { ErrandClient, ErrandService, ErrandStores, RunOutcome } from '../src/errands/types.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

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
function makeEnv(memoryDb: MemoryDb | null, { openPrivate = false } = {}): Rig {
  const hot = {
    config: {
      context: { memory: { openPrivate } },
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
  const errands = createErrandService({ client, stores, hot, now: () => NOW, log: SILENT });
  const env = createOpsEnv({
    mediaNameOf: noMediaNames,
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    errands,
    now: () => NOW,
  });
  return { env, client, errands, stores };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What an answer says: its status, code, summary and data. */
async function ask(env: Env, name: string, args: Obj, accountId: string = MEMBER): Promise<Answer> {
  const { status, code, summary, data } = await runOp(name, args, {
    env,
    placeId: 'g1',
    chatId: 'c1',
    accountId,
    roleIds: [],
  });
  return { status, code, summary, data };
}

/** The id of the errand an `errand.scout` answer names. */
function idOf(answer: Answer): string {
  const data = answer.data;
  const task = data !== null && typeof data === 'object' && 'task' in data ? data.task : null;
  const id = task !== null && typeof task === 'object' && 'id' in task ? task.id : null;
  if (typeof id !== 'string') throw new Error(`no errand id in ${answer.summary}`);
  return id;
}

/** Errand `id`'s task on the board as the read connection of `memoryDb` shows it. */
function taskOf(memoryDb: MemoryDb, id: string): BoardTask['task'] {
  // service.js types its read handle loosely; it is open.js's handle, `{ db }`, or null while the database is closed.
  const handle = memoryDb.readHandle() as { db: object } | null;
  if (!handle) throw new Error('the memory database is not open');
  const view = boardTaskOf(handle.db, id);
  if (view === null) throw new Error(`the board holds no task ${id}`);
  return view.task;
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

test('errand.scout files the errand on the board as a scout task in progress once it is sent', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-run-');
    const { env, stores } = makeEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.scout', { goal: 'find the changelog' }));
    await tick();
    await stores.flush();
    const task = taskOf(memoryDb, id);
    // Changed: the board holds errands only, so a task has no lane left to check.
    assert.deepEqual([task.role, task.status], ['scout', 'in_progress']);
  });
});

test('errand.cancel moves the board task to cancelled', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-cancel-');
    const { env, stores, errands } = makeEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.scout', { goal: 'find the changelog' }));
    await tick();
    assert.equal((await ask(env, 'errand.cancel', { id })).status, 'ok');
    await errands.idle();
    await stores.flush();
    assert.equal(taskOf(memoryDb, id).status, 'cancelled');
  });
});

for (const openPrivate of [true, false])
  test(`errand.list of an errand asked in another person's direct chat ${openPrivate ? 'answers' : 'is not-found'} in a group with openPrivate ${openPrivate}`, async () => {
    // Bug: the switch opens her memory, but her tool still hides an errand of a direct chat from a group turn.
    await withCapturedLogs(async () => {
      const { env, errands } = makeEnv(null, { openPrivate });
      const added = errands.submit({
        agent: 'scout',
        goal: 'find the changelog',
        requester: { accountId: '99', kind: 'member' },
        origin: { placeId: 'dm-99', messageId: null },
        scope: 'dm',
      });
      const id = added.errand?.id ?? '';
      const answer = await ask(env, 'errand.list', { id });
      assert.equal(answer.status === 'ok', openPrivate, answer.summary);
    });
  });
