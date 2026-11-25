// Tests for src/errands/store.ts: the persona's errand tasks, per guild, in the memory database of a temp data/
// directory. A task moves queued -> running -> done | failed | cancelled, each one a task of the board with one status
// event per transition, the caps refuse with their codes (open at once, tasks and dollars per UTC day), the journal
// gets one operation per task with counts only, and a file handle resolves only to a file the task's result lists.
// Later sections cover the reads from the database and the end of an errand on the board, in one writer transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { consumers, consumerRig } from '../../fixtures/agent-consumers.ts';
import { createErrandStore, fileHandle, parseFileHandle, createErrandStores } from '../../../src/errands/store.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { openTestMemorySync, tempDataDir as deliveryTempDataDir } from '../../fixtures/memory-db/service.ts';
import { boardTaskOf } from '../../fixtures/board-task.ts';
import type { BoardTask } from '../../fixtures/board-task.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { AddInput, ErrandStore } from '../../../src/errands/types.ts';
import { T0 as T0_DELIVERY } from '../../fixtures/errand-archive.ts';
import { GUILD, readerEnv } from '../../fixtures/memory-db/readers.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { createErrandTurns, errandDoneEvent } from '../../../src/errands/turns.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import type { BoardDb } from '../../../src/board/schema.ts';
import { channel, rig } from '../../fixtures/reads-rig.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-17T10:00:00Z');

function tempDataDir() {
  return tempDir('errands-store-');
}

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir: string) {
  let memory = MEMORY.get(dataDir);
  if (memory === undefined) {
    memory = openTestMemorySync({ dataDir });
    MEMORY.set(dataDir, memory);
  }
  return memory.memoryDb;
}

/**
 * Task `id` as the board of `dataDir` shows it, once `store`'s writes landed.
 */
async function boardTask(store: ReturnType<typeof createErrandStore>, dataDir: string, id: string): Promise<BoardTask> {
  await store.flush();
  // @ts-expect-error: the read handle is null only after close
  const view = boardTaskOf(memoryOf(dataDir).readHandle().db, id);
  if (view === null) throw new Error(`the board holds no task ${id}`);
  return view;
}

/**
 * The statuses a board task passed through, in order.
 */
// The id of an errand a test just queued; the type of the queued record leaves it optional.
const idOf = (errand: unknown): string => String(loose(errand).id);

const statusesOf = (view: { events: Array<{ type: string; new?: unknown }> }) =>
  view.events.filter((event) => event.type === 'status').map((event) => event.new);

function makeStore({
  dataDir = tempDataDir(),
  clock = { t: T0 },
  errands = {},
  agents = {},
  journal = null,
  stateDir = path.join(os.tmpdir(), 'errands-no-such-state-dir'),
}: {
  dataDir?: string;
  clock?: { t: number };
  errands?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  journal?: Parameters<typeof createErrandStore>[0]['journal'];
  /** the state folder of a user unit, whose `neptunia-agent-scout/out` is the scout's out folder */
  stateDir?: string;
} = {}) {
  const config = {
    errands: { maxOpen: 3, ...errands },
    agents: {
      scout: { daily: { tasks: 5 } },
      server: { daily: { tasks: 2 } },
      ...agents,
    },
  };
  let n = 0;
  const store = createErrandStore({
    // @ts-expect-error: createErrandStore takes no `dataDir`; the memory database holds the board, so the key is ignored
    dataDir,
    placeId: 'g1',
    now: () => clock.t,
    config: () => config,
    journal,
    memoryDb: memoryOf(dataDir),
    agentPaths: { env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_STATE_HOME: stateDir } },
    uuid: () => `${(n += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
  });
  return { store, dataDir, clock, config };
}

const asked: AddInput = {
  agent: 'scout',
  goal: 'find the release notes',
  requester: { accountId: 'u1', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group',
};

test('task store: a new task is queued and written to the board as an approved errand task', async () => {
  await withCapturedLogs(async () => {
    const { store, dataDir } = makeStore();
    const added = store.add(asked);
    assert.equal(added.ok, true);
    const { errand: task } = added;
    assert.match(task.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(task.state, 'queued');
    assert.equal(task.agent, 'scout');
    assert.equal(task.goal, 'find the release notes');
    assert.deepEqual(task.requester, { accountId: 'u1', kind: 'member' });
    assert.deepEqual(task.origin, { placeId: 'c1', messageId: 'm1' });
    assert.equal(task.scope, 'group');
    assert.equal(task.createdAt, T0);
    assert.equal(task.seen, false);
    assert.equal(task.result, null);
    const view = await boardTask(store, dataDir, task.id);
    // The board holds errands only, so a task has no lane left to check.
    assert.equal(view.task.status, 'approved');
    assert.deepEqual(statusesOf(view), ['approved']);
    // A second store over the same directory reads the list back.
    // @ts-expect-error: createErrandStore takes no `dataDir`; the memory database holds the board, so the key is ignored
    const again = createErrandStore({ dataDir, placeId: 'g1', memoryDb: memoryOf(dataDir), now: () => T0 });
    assert.equal(loose(again.get(task.id)).goal, 'find the release notes');
  });
});

test('task store: queued -> running -> done; the end is written once, a late one ignored', async () => {
  await withCapturedLogs(async () => {
    const { store, dataDir, clock } = makeStore();
    const { errand: task } = store.add(asked);
    clock.t += 1000;
    assert.equal(loose(store.start(idOf(task))).state, 'running');
    assert.equal(store.start(idOf(task)), null, 'only a queued task starts');
    assert.deepEqual(
      store.open().map((t) => t.id),
      [idOf(task)]
    );
    clock.t += 5000;
    const done = store.finish(idOf(task), {
      status: 'done',
      result: { text: 'here', sources: ['https://example.org'], files: [] },
      usage: { usd: 0.25, steps: 3 },
    });
    assert.equal(loose(done).state, 'done');
    assert.equal(loose(done).endedAt, T0 + 6000);
    assert.equal(loose(done).result.text, 'here');
    assert.equal(loose(done).usage.usd, 0.25);
    assert.equal(loose(done).error, null);
    assert.equal(Object.hasOwn(loose(done).result as object, 'filesDropped'), false, 'none held back, no key');
    assert.equal(store.finish(idOf(task), { status: 'failed' }), null);
    assert.deepEqual(store.open(), []);
    assert.deepEqual(
      store.unseen().map((t) => t.id),
      [idOf(task)]
    );
    assert.equal(loose(store.markSeen(idOf(task))).seen, true);
    assert.deepEqual(store.unseen(), []);
    assert.equal(store.today('scout').usd, 0.25);
    assert.deepEqual(statusesOf(await boardTask(store, dataDir, idOf(task))), ['approved', 'in_progress', 'done']);
  });
});

test('task store: the files the runner held back are kept as names only', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.start(idOf(task));
    const done = store.finish(idOf(task), {
      status: 'done',
      result: {
        text: 'here',
        filesDropped: [
          { name: 'x.env', reason: 'secret' },
          { name: 'a.txt', reason: 'secret' },
          { name: 'b', reason: 'other' },
        ],
      },
    });
    // `a.txt` carries `secret`: the runner drops files for that one reason, and the protocol passes no other.
    assert.deepEqual(loose(done).result.filesDropped, ['x.env', 'a.txt']);
  });
});

test("task store: a cancel closes an open task; the runner's later end changes nothing", async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.start(idOf(task));
    const cancelled = store.cancel(idOf(task));
    assert.equal(loose(cancelled).state, 'cancelled');
    assert.equal(loose(cancelled).error, 'cancelled');
    assert.equal(store.finish(idOf(task), { status: 'done', result: { text: 'late' } }), null);
    assert.equal(loose(store.get(idOf(task))).state, 'cancelled');
    assert.equal(store.cancel(idOf(task)), null);
    assert.equal(store.cancel('nope'), null);
  });
});

test('task store: the caps refuse with cap-open and cap-tasks, a dollar figure never refuses, and the day rolls over', async () => {
  await withCapturedLogs(() => {
    const { store, clock } = makeStore({ errands: { maxOpen: 2 } });
    assert.equal(store.add(asked).ok, true);
    const second = store.add(asked);
    assert.equal(second.ok, true);
    assert.deepEqual(store.add(asked), { ok: false, code: 'cap-open' });
    assert.equal(store.budget('scout').spent, true);
    assert.equal(store.budget('scout').key, 'errands.maxOpen');
    store.finish(store.open()[0].id, { status: 'done', result: { text: '' }, usage: { usd: 0.1 } });
    store.finish(second.errand.id, { status: 'failed', error: 'x' });
    // server: two tasks a day.
    const server: AddInput = { ...asked, agent: 'server', requester: { accountId: 'owner', kind: 'owner' } };
    const s1 = store.add(server).errand;
    store.finish(loose(s1).id, { status: 'done', usage: { usd: 0.1 } });
    const s2 = store.add(server).errand;
    store.finish(loose(s2).id, { status: 'done', usage: { usd: 0.1 } });
    assert.deepEqual(store.add(server), { ok: false, code: 'cap-tasks' });
    // scout: what a day's tasks cost refuses nothing.
    const w = store.add(asked).errand;
    store.finish(loose(w).id, { status: 'done', usage: { usd: 500 } });
    assert.equal(store.budget('scout').spent, false);
    assert.equal(store.add(asked).ok, true);
    store.finish(store.open()[0].id, { status: 'done', usage: { usd: 500 } });
    // A new UTC day: the task count starts again.
    clock.t += DAY;
    assert.equal(store.add(asked).ok, true);
    assert.equal(store.add(server).ok, true);
    assert.deepEqual(store.add({ ...asked, agent: 'mail' }), { ok: false, code: 'unknown-agent' });
    assert.deepEqual(store.add({ ...asked, goal: '  ' }), { ok: false, code: 'bad-goal' });
  });
});

test('task store: every transition is one journal operation, counts only', async () => {
  const lines: Array<Untyped> = [];
  const journal = { action: async (placeId: string, record: Untyped) => lines.push({ placeId, ...record }) };
  await withCapturedLogs(async () => {
    const { store } = makeStore({ journal });
    const { errand: task } = store.add(asked);
    store.start(idOf(task));
    store.finish(idOf(task), {
      status: 'done',
      result: {
        text: 'secret answer text',
        sources: ['https://a', 'https://b'],
        files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 3 }],
      },
      usage: { usd: 0.02, steps: 2 },
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      lines.map((line) => line.phase),
      ['proposed', 'started', 'succeeded']
    );
    assert.equal(new Set(lines.map((line) => line.opId)).size, 1, 'one operation per task');
    for (const line of lines) {
      assert.equal(line.name, 'errand');
      assert.equal(line.placeId, 'c1');
      assert.deepEqual(line.participants, ['u1']);
      assert.deepEqual(line.sourceMessageIds, ['m1']);
    }
    assert.deepEqual(lines[2].result, {
      errandId: idOf(task),
      state: 'done',
      chars: 18,
      sources: 2,
      files: 1,
      usage: { usd: 0.02, steps: 2, seconds: 0 },
    });
    const all = JSON.stringify(lines);
    assert.ok(!all.includes('release notes') && !all.includes('secret answer'), 'never the goal or the result');
    // A failure closes with its code.
    const failedTask = store.add(asked).errand;
    store.finish(loose(failedTask).id, { status: 'failed', error: 'withheld-path' });
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.at(-1).phase, 'failed');
    assert.equal(lines.at(-1).result.code, 'withheld-path');
  });
});

test("task store: a DM task journals into the requester's private layer", async () => {
  const lines: Array<Untyped> = [];
  await withCapturedLogs(async () => {
    const { store } = makeStore({
      journal: { action: async (placeId: string, record: Untyped) => lines.push(record) },
    });
    store.add({ ...asked, scope: 'dm', origin: { placeId: 'dm1', messageId: 'm9' } });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(lines[0].privateAccountId, 'u1');
  assert.equal(lines[0].placeId, undefined);
});

test('task store: a file handle resolves only to a file the task lists, inside its out directory', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.finish(idOf(task), {
      status: 'done',
      result: {
        text: 'ok',
        files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 1234 }],
      },
    });
    const handle = fileHandle(idOf(task), 'meme.png');
    assert.equal(handle, `file:${idOf(task)}/meme.png`);
    assert.deepEqual(parseFileHandle(handle), { id: idOf(task), name: 'meme.png' });
    const file = store.fileOf(handle);
    assert.equal(
      loose(file).path,
      // The out folder is the scout unit's.
      path.resolve(os.tmpdir(), 'errands-no-such-state-dir', 'neptunia-agent-scout', 'out', idOf(task), 'meme.png'),
      'the out directory, never the path the runner wrote'
    );
    assert.equal(loose(file).contentType, 'image/png');
    assert.equal(loose(file).bytes, 1234);
    assert.equal(store.fileOf(`file:${idOf(task)}/other.png`), null);
    assert.equal(store.fileOf('file:tnope/meme.png'), null);
    assert.equal(store.fileOf(`file:${idOf(task)}/../meme.png`), null);
    assert.equal(parseFileHandle(`file:${idOf(task)}/..`), null);
    assert.equal(store.fileOf('meme.png'), null);
  });
});

test('task store: recent lists newest first; failOpen fails what a restart left open', async () => {
  await withCapturedLogs(() => {
    const { store, clock } = makeStore({ errands: { maxOpen: 5 } });
    const a = store.add(asked).errand;
    clock.t += 10;
    const b = store.add(asked).errand;
    clock.t += 10;
    const c = store.add(asked).errand;
    store.start(loose(b).id);
    assert.deepEqual(
      store.recent(2).map((t) => t.id),
      [loose(c).id, loose(b).id]
    );
    assert.equal(store.failOpen('restarted'), 3);
    assert.deepEqual(store.open(), []);
    for (const id of [loose(a).id, loose(b).id, loose(c).id]) {
      assert.equal(loose(store.get(id)).state, 'failed');
      assert.equal(loose(store.get(id)).error, 'restarted');
    }
  });
});

// The mark is written to the errand's board task, in its metadata.
test("task store: a finished task's files expire once the runner removed its directory; the handle then names nothing", async () => {
  await withCapturedLogs(async () => {
    // The out folder is the scout unit's, under the state folder of a user unit.
    const stateDir = tempDir('errands-state-');
    const out = path.join(stateDir, 'neptunia-agent-scout', 'out');
    fs.mkdirSync(out, { recursive: true });
    const { store, dataDir } = makeStore({ errands: { maxOpen: 5 }, stateDir });
    const files = [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 12 }];
    const kept = store.add(asked).errand;
    const gone = store.add(asked).errand;
    const bare = store.add(asked).errand;
    const open = store.add(asked).errand;
    for (const id of [idOf(kept), idOf(gone)]) store.finish(id, { status: 'done', result: { text: 'ok', files } });
    store.finish(loose(bare).id, { status: 'done', result: { text: 'no files' } });
    fs.mkdirSync(path.join(out, idOf(kept)));
    // The directory of `gone` was never there (as after the runner's sweep), nor that of `bare` or `open`.
    assert.equal(loose(store.get(idOf(gone))).filesExpired, true);
    assert.equal(loose(store.get(idOf(kept))).filesExpired, undefined);
    assert.equal(
      loose(store.get(loose(bare).id)).filesExpired,
      undefined,
      'a task without files has nothing to expire'
    );
    assert.equal(loose(store.get(loose(open).id)).filesExpired, undefined, 'an open task is never marked');
    assert.equal(store.fileOf(fileHandle(idOf(gone), 'meme.png')), null);
    assert.ok(store.fileOf(fileHandle(idOf(kept), 'meme.png')));
    assert.ok(loose(store.unseen().find((t) => t.id === idOf(gone))).filesExpired);
    // The board's reader returns a task row as stored, so its metadata is JSON text.
    const saved = loose(JSON.parse(String((await boardTask(store, dataDir, idOf(gone))).task.metadata))).errand;
    assert.equal(loose(saved).filesExpired, true, 'written to the board');
    assert.equal(store.expireFiles(), 0, 'marked once');
    fs.rmSync(path.join(out, idOf(kept)), { recursive: true });
    assert.equal(loose(store.recent(10).find((t) => t.id === idOf(kept))).filesExpired, true);
  });
});

test('task store: no out dir at all (no runner on this host) expires nothing', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.finish(idOf(task), {
      status: 'done',
      result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] },
    });
    assert.equal(store.expireFiles(), 0);
    assert.equal(loose(store.get(idOf(task))).filesExpired, undefined);
  });
});

// After a restart the spend records come from the errands on the board.
test('task store: costs and the daily caps read the same spend records, rebuilt from the board after a restart', async () => {
  await withCapturedLogs(async () => {
    const dataDir = tempDataDir();
    const clock = { t: T0 };
    const { store, config } = makeStore({ dataDir, clock });
    const old = store.add(asked).errand;
    store.finish(loose(old).id, { status: 'done', usage: { input: 5000, output: 500, usd: 0.3 } });
    clock.t += 3 * DAY;
    const a = store.add(asked).errand;
    store.start(loose(a).id);
    store.finish(loose(a).id, { status: 'done', usage: { input: 1000, output: 100, usd: 0.6, steps: 2 } });
    const b = store.add({ ...asked, requester: { accountId: 'u2', kind: 'member' } }).errand;
    store.finish(loose(b).id, { status: 'failed', error: 'x', usage: { input: 2000, output: 200, usd: 0.3 } });
    const costs = store.costs(['scout', 'dev']);
    assert.deepEqual(Object.keys(costs), ['scout', 'dev']);
    assert.deepEqual(costs.scout.today, { runs: 2, input: 3000, output: 300, usd: 0.8999999999999999 });
    const { scout, dev } = costs;
    assert.equal(scout.last7.runs, 3);
    assert.equal(dev.last30.runs, 0);
    assert.deepEqual(
      store.today('scout'),
      { tasks: scout.today.runs, usd: scout.today.usd, caps: { tasks: 5 } },
      "the caps read the costs' today"
    );
    const c = store.add(asked).errand;
    store.finish(loose(c).id, { status: 'done', usage: { usd: 0.2 } });

    // A restart: the board gives the same numbers back.
    await store.flush();
    const again = createErrandStore({
      // @ts-expect-error: createErrandStore takes no `dataDir`; the memory database holds the board, so the key is ignored
      dataDir,
      placeId: 'g1',
      memoryDb: memoryOf(dataDir),
      now: () => clock.t,
      config: () => config,
    });
    assert.deepEqual(again.costs(), store.costs());
  });
});

test("task store: the persona's call keeps its turn and its brief as written; the same idempotency key again is that task, never a second, before any cap", async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore({ errands: { maxOpen: 1 } });
    const brief = '  Βρες το πιο δημοφιλές έργο με την ετικέτα serial_experiments_lain και φέρε το αρχείο.  ';
    const personaInput: AddInput = {
      ...asked,
      goal: brief,
      requester: { accountId: 'u1', kind: 'member' },
      origin: { placeId: 'c1', messageId: 'm1', turnId: 'turn-7' },
      idempotencyKey: 'turn-7.1:0',
    };
    const first = store.add(personaInput);
    assert.equal(first.ok, true);
    assert.equal(first.errand.goal, brief.trim(), 'the brief as the persona wrote it');
    assert.deepEqual(first.errand.origin, { placeId: 'c1', messageId: 'm1', turnId: 'turn-7' });
    assert.equal(first.errand.idempotencyKey, 'turn-7.1:0');
    const again = store.add({ ...personaInput, goal: 'κάτι άλλο' });
    assert.deepEqual(
      [again.ok, again.duplicate, loose(again.errand).id, loose(again.errand).goal],
      [true, true, first.errand.id, brief.trim()],
      'the same call: the same task, even past the open cap'
    );
    assert.equal(store.recent(10).length, 1);
    // Another call of the same turn is another errand (here refused by the cap of one open task).
    assert.deepEqual(
      [store.add({ ...personaInput, idempotencyKey: 'turn-7.1:1' }).ok, store.recent(10).length],
      [false, 1]
    );
    // A command brings neither: no turn, no key.
    const { store: other } = makeStore();
    const plain = other.add(asked).errand;
    assert.deepEqual(loose(plain).origin, { placeId: 'c1', messageId: 'm1' });
    assert.equal('idempotencyKey' in loose(plain), false);
  });
});

test('an existing store reads the personal daily cap again after a profile edit', () => {
  const rig = consumerRig();
  rig.override({ daily: { tasks: 3 } });
  const store = consumers.store({
    agentPaths: rig.options,
    now: () => Date.parse('2026-11-03T12:00:00Z'),
  });
  try {
    assert.equal(store.today('scout').caps.tasks, 3);
    rig.override({ daily: { tasks: 1 } });
    assert.equal(store.today('scout').caps.tasks, 1);
    assert.equal(
      store.add({
        agent: 'scout',
        goal: 'inspect synthetic files',
        scope: 'group',
        requester: { accountId: 'synthetic-user', kind: 'member' },
        origin: { placeId: 'synthetic-room', messageId: 'synthetic-message' },
      }).ok,
      true
    );
    assert.equal(store.budget('scout').code, 'cap-tasks');
  } finally {
    rig.close();
  }
});

test('an errand an internal turn asked for keeps its publication restriction on its record', () => {
  // Bug: the record forgets its origin's restriction, so the result turn may post private work to a group.
  const boundary = { kind: 'internal-turn', origin: { iface: 'cli', chatId: 'dm-owner' } } as const;
  const dataDir = tempDir('nep-errand-boundary-');
  // @ts-expect-error: createErrandStore takes no `dataDir`; the memory database holds the board
  const first = createErrandStore({ dataDir, placeId: 'g1', memoryDb: memoryOf(dataDir), now: () => 1000 });
  const added = first.add({
    agent: 'scout',
    goal: 'find it',
    requester: { kind: 'owner', accountId: 'u1' },
    origin: { placeId: 'dm-owner', messageId: null, publicationBoundary: boundary },
    scope: 'dm',
  });
  // `add` answers the record itself or wraps it, depending on the idempotency key.
  const record = ('errand' in added ? added.errand : added) as { origin: { publicationBoundary?: unknown } };
  assert.deepEqual(record.origin.publicationBoundary, boundary);
});

test('task store: a board write that failed is sent again by the next flush', async () => {
  // Catches: a store that drops the write the database refused, so the errand is missing from the board.
  await withCapturedLogs(async () => {
    const dataDir = tempDataDir();
    const service = memoryOf(dataDir);
    let down = true;
    const memoryDb = {
      ...service,
      writeErrand: (write: Parameters<typeof service.writeErrand>[0]) =>
        down ? Promise.reject(Object.assign(new Error('down'), { code: 'DB_CLOSED' })) : service.writeErrand(write),
    };
    const store = createErrandStore({
      memoryDb,
      now: () => T0,
      config: () => ({ errands: { maxOpen: 3 }, agents: { scout: { daily: { tasks: 5 } } } }),
    });
    const added = store.add(asked);
    assert.equal(added.ok, true);
    assert.equal((await store.flush()).waiting, 1);
    down = false;
    assert.equal((await store.flush()).waiting, 0);
    const view = await boardTask(store, dataDir, idOf(added.ok ? added.errand : null));
    assert.deepEqual(statusesOf(view), ['approved']);
  });
});

// The delivery mark of an errand's end (src/errands/store.ts#markDelivered) reaches the board while the core runs. The
// door takes the `errand.done` as soon as the end's own write committed, often before that write's promise settled in
// the store's outbox, and the mark must still land then, not only at the core's stop: a core that crashes after the
// delivery and starts again must find the end delivered, or it opens a second result turn. The memory service is the
// real one on the calling thread (fixtures/memory-db/service.ts); a gate holds the store's writes after they commit, so
// the end is on the board while its write still counts as under way. No flush runs between the mark and the restart.

const NOW = T0_DELIVERY + 60 * 60 * 1000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const CONFIG = {
  errands: { maxOpen: 3 },
  agents: { scout: { daily: { tasks: 5 } } },
};
const ASKED = {
  agent: 'scout',
  goal: 'find the opening hours of the library',
  requester: { accountId: 'u1', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm7' },
  scope: 'group' as const,
};
const DONE = { status: 'done', result: { text: 'Open until eight.', sources: [], files: [] }, usage: { usd: 0.02 } };

type MemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];

const OPENED: Array<{ close: () => unknown }> = [];

let counter = 0;
const uuid = (): string => `${(counter += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

const storeOver = (memoryDb: MemoryDb): ErrandStore =>
  createErrandStore({ now: () => NOW, config: () => CONFIG, uuid, log: SILENT, memoryDb });

/** A few turns of the event loop, with no flush of any store. */
async function ticks(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `memoryDb` with its errand writes held after they commit: each write lands in the database at once, and its promise
 * settles only while the gate is open (`hold` closes it, `release` opens it).
 */
function gated(memoryDb: MemoryDb): { memoryDb: MemoryDb; hold: () => void; release: () => void } {
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  const writeErrand = async (write: Parameters<MemoryDb['writeErrand']>[0]): Promise<unknown> => {
    const written: unknown = await memoryDb.writeErrand(write);
    await gate;
    return written;
  };
  // The fixture's service is a plain object of functions; the gated one differs from it in `writeErrand` alone.
  const wrapped: MemoryDb = { ...memoryDb, writeErrand };
  return {
    memoryDb: wrapped,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}
after(async () => {
  for (const memory of OPENED) await memory.close();
});

test('an end marked delivered while its own write is still under way is delivered on the board without a stop', async () => {
  const memory = openTestMemorySync({
    dataDir: deliveryTempDataDir('nep-errands-delivery-'),
    now: () => NOW,
    log: SILENT,
  });
  OPENED.push(memory);
  const slow = gated(memory.memoryDb);
  const store = storeOver(slow.memoryDb);
  const added = store.add(ASKED);
  const id = added.errand?.id ?? '';
  store.start(id);
  await store.flush();
  slow.hold();
  store.finish(id, DONE);
  // The end commits on the board while the store's write of it is still held.
  for (let i = 0; i < 50 && storeOver(memory.memoryDb).pendingEnds().length === 0; i += 1) await ticks(1);
  assert.equal(store.markDelivered(id), true);
  slow.release();
  await ticks();
  // A core started again after a crash: no stop flushed the first store.
  assert.deepEqual(storeOver(memory.memoryDb).pendingEnds(), []);
});

// The reads from the database: the list and the spend records load from the database, and a failed load is an
// error with a code that the next `get` tries again. The fixture is seeded at board v2 and its errands reach the
// board through board v3's move.

const READER_NOW = 1792000600000;

function config(root: string) {
  const out = path.join(root, 'no-out');
  return () => ({ agents: new Proxy({}, { get: () => ({ out }) }) });
}

const ids = (tasks: Array<{ id: string }>) => tasks.map((task) => task.id);

// The same lists, read from the board tasks board v3 made of the archive.
test('tasks db reader: the list and the spend records come from the database', async () => {
  const env = await readerEnv({ archived: true });
  try {
    const stores = createErrandStores({
      log: env.log,
      memoryDb: env.memoryDb,
      config: config(env.root),
      now: () => READER_NOW,
    });
    // Tasks are the persona's: one store, whichever place asks.
    for (const [placeId, id] of [[GUILD, 't1']]) {
      const store = stores.get()!;
      assert.deepEqual(
        {
          open: ids(store.open()),
          recent: ids(store.recent(100)),
          unseen: ids(store.unseen()),
          unread: ids(store.unread()),
          costs: store.costs(),
        },
        { open: [], recent: [id], unseen: [], unread: [], costs: {} },
        placeId
      );
      assert.equal(store.get('nope') ?? null, null);
    }
    // The fixture's record has no agent, goal, error or result. The board keeps those in its columns (role, title,
    // close_reason, the handoff), so the rebuilt errand carries them empty. Every errand the store adds has all four.
    assert.deepEqual(stores.get()!.get('t1'), {
      id: 't1',
      agent: '',
      goal: '',
      error: null,
      result: null,
      state: 'done',
      createdAt: 1792000000000,
      requester: { accountId: '100000000000000001' },
      scope: 'group',
      seen: true,
      readAt: 1792000000000,
      resolvedAt: null,
    });
    assert.deepEqual(
      env.warns.filter((warn) => warn.message === 'memory db: read failed'),
      []
    );
  } finally {
    env.done();
  }
});

// The retried load finds the errand on the board.
test('tasks db reader: a closed database fails the load with a code, logged; the next get tries again', async () => {
  const env = await readerEnv({ archived: true });
  try {
    let open = false;
    const memoryDb = { readHandle: () => (open ? env.handle : null), database: () => (open ? env.handle.db : null) };
    const stores = createErrandStores({ log: env.log, memoryDb, config: config(env.root), now: () => READER_NOW });
    assert.throws(
      () => stores.get(),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [['memory db: read failed', 'tasks', 'DB_CLOSED']]
    );
    open = true;
    assert.equal(stores.get()!.get('t1')?.id, 't1');
  } finally {
    env.done();
  }
});

// The store on the task board: it reads the errands back from the board as the `work` archive held them, writes
// nothing to the archive or to an errand unit, ends an errand in one writer transaction (the board move, its status
// event, the outbox row to `persona`, the closing journal line, all or none), and keeps an end it committed pending
// until its `errand.done` is marked delivered. A failure inside the transaction is injected with a SQLite trigger.

const BOARD_NOW = T0_DELIVERY + 60 * 60 * 1000;
const BOARD_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const BOARD_CONFIG = {
  features: { journal: true },
  errands: { maxOpen: 3, resultCooldownSeconds: 0, resultRetrySeconds: 0 },
  agents: { scout: { daily: { tasks: 5 } }, server: { daily: { tasks: 5 } } },
  mention: { oneAtATime: true },
};

const BOARD_ASKED = {
  agent: 'scout',
  goal: 'find the opening hours of the library',
  requester: { accountId: 'u1', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm7' },
  scope: 'group' as const,
};

type BoardMemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];
type Rig = { memoryDb: BoardMemoryDb; dataDir: string; store: ErrandStore; journal: ReturnType<typeof createJournal> };

const BOARD_OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of BOARD_OPENED) await memory.close();
});

let boardCounter = 0;
const boardUuid = (): string => `${(boardCounter += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

/** The memory service over `dataDir` (a new one when omitted), the real journal over it, and a store of the guild. */
function setUp(dataDir: string = deliveryTempDataDir('nep-errands-board-')): Rig {
  const memory = openTestMemorySync({ dataDir, now: () => BOARD_NOW, log: BOARD_SILENT });
  BOARD_OPENED.push(memory);
  const journal = createJournal({
    dataDir,
    config: () => BOARD_CONFIG,
    now: () => BOARD_NOW,
    uuid: boardUuid,
    log: BOARD_SILENT,
    memoryDb: memory.memoryDb,
  });
  return { memoryDb: memory.memoryDb, dataDir, journal, store: boardStoreOver(memory.memoryDb, journal) };
}

/** A store of the guild over `memoryDb`, as a core started anew builds it. */
function boardStoreOver(memoryDb: BoardMemoryDb, journal: ReturnType<typeof createJournal> | null = null): ErrandStore {
  return createErrandStore({
    now: () => BOARD_NOW,
    config: () => BOARD_CONFIG,
    journal,
    uuid: boardUuid,
    log: BOARD_SILENT,
    memoryDb,
  });
}

/** The read connection of the service, as the board's reads take it. */
function readDb(memoryDb: BoardMemoryDb): BoardDb {
  // service.js types its read handle loosely; it is open.js's handle, `{ db }`, or null while the database is closed.
  const handle: { db: object } | null = memoryDb.readHandle();
  if (!handle) throw new Error('the memory database is not open');
  // The read handle's connection is node:sqlite's DatabaseSync, which has every method BoardDb names.
  return handle.db as BoardDb;
}

/** Every write the store and the journal sent, landed. */
async function boardSettle(store: ErrandStore): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await store.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A trigger on the database file that aborts the statement it guards, for a failure inside the end's transaction. */
function inject(dataDir: string, sql: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** The phases of the journal lines whose `day` row references errand `id`, in the order they were written. */
function workPhases(memoryDb: BoardMemoryDb, id: string): Array<string> {
  return readDb(memoryDb)
    .prepare("SELECT json_extract(extra, '$.phase') AS phase FROM day WHERE work_id = ? ORDER BY rowid")
    .all(id)
    .map((row) => String(row.phase));
}

const closingLines = (memoryDb: BoardMemoryDb, id: string): number =>
  workPhases(memoryDb, id).filter((phase) => phase === 'succeeded' || phase === 'failed').length;

const outboxRows = (memoryDb: BoardMemoryDb, id: string): Array<Record<string, unknown>> =>
  readDb(memoryDb).prepare('SELECT * FROM board_outbox WHERE task_id = ? ORDER BY seq').all(id);

/** Errand `id`'s task on the board as the read connection of `memoryDb` shows it. */
function taskOf(memoryDb: BoardMemoryDb, id: string): BoardTask['task'] {
  const view = boardTaskOf(readDb(memoryDb), id);
  if (view === null) throw new Error(`the board holds no task ${id}`);
  return view.task;
}

const statusOf = (memoryDb: BoardMemoryDb, id: string): string => taskOf(memoryDb, id).status;

/** An errand of the scout queued and started, its writes landed. */
async function running(rig: Rig): Promise<string> {
  const added = rig.store.add(BOARD_ASKED);
  assert.equal(added.ok, true);
  const id = added.errand?.id ?? '';
  rig.store.start(id);
  await boardSettle(rig.store);
  return id;
}

const BOARD_DONE = {
  status: 'done',
  result: { text: 'Open until eight.', sources: [], files: [] },
  usage: { usd: 0.02 },
};

test('an errand end commits the board move, the outbox row to persona and the closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'done');
  assert.deepEqual(
    outboxRows(rig.memoryDb, id).map((row) => [row.to_whom, row.kind]),
    [['persona', 'done']]
  );
  assert.equal(closingLines(rig.memoryDb, id), 1);
});

test('a failing closing journal line leaves the errand in progress on the board with no outbox row', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    `CREATE TRIGGER fail_closing BEFORE INSERT ON day WHEN json_extract(NEW.extra, '$.phase') = 'succeeded'
     BEGIN SELECT RAISE(ABORT, 'injected'); END;`
  );
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('a failing outbox row leaves the errand in progress on the board with no closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON board_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END;"
  );
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('a failing status event leaves the errand in progress with no outbox row and no closing journal line', async () => {
  // Bug: an end that writes its status and outbox row outside the transaction of its event, so a failed event leaves
  // an errand done on the board with no history of the move, or an end delivered twice.
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    `CREATE TRIGGER fail_event BEFORE INSERT ON board_events WHEN NEW.new = 'done'
     BEGIN SELECT RAISE(ABORT, 'injected'); END;`
  );
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('a failing board move leaves no outbox row and no closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    `CREATE TRIGGER fail_move BEFORE UPDATE OF status ON board_tasks WHEN NEW.status = 'done'
     BEGIN SELECT RAISE(ABORT, 'injected'); END;`
  );
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('an end committed before a restart is pending once at the next start, under its errand-done event id', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  const restarted = boardStoreOver(rig.memoryDb);
  assert.deepEqual(restarted.pendingEnds(), [{ eventId: `errand-done:${id}`, errandId: id, state: 'done' }]);
});

test('an end marked delivered is pending no more, after a restart too', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.equal(rig.store.markDelivered(id), true);
  await boardSettle(rig.store);
  const restarted = boardStoreOver(rig.memoryDb);
  assert.deepEqual(restarted.pendingEnds(), []);
  assert.equal(restarted.markDelivered(id), false);
});

test("the persona's journal lines of an errand reference its task, whose title is what the persona asked the scout for", async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, BOARD_DONE);
  await boardSettle(rig.store);
  assert.deepEqual(workPhases(rig.memoryDb, id), ['proposed', 'started', 'succeeded']);
  const proposed = readDb(rig.memoryDb)
    .prepare("SELECT json_extract(extra, '$.input.agent') AS agent FROM day WHERE work_id = ? ORDER BY rowid LIMIT 1")
    .get(id);
  assert.equal(proposed?.agent, 'scout');
  assert.equal(taskOf(rig.memoryDb, id).title, BOARD_ASKED.goal);
});

test('an errand.done delivered twice opens one result turn and leaves one closing journal line', async () => {
  const memory = setUp();
  const stores = createErrandStores({
    config: () => BOARD_CONFIG,
    journal: memory.journal,
    now: () => BOARD_NOW,
    log: BOARD_SILENT,
    memoryDb: memory.memoryDb,
  });
  const hot = { config: BOARD_CONFIG, prompts: {} };
  const service = createErrandService({
    client: {},
    stores,
    hot,
    log: BOARD_SILENT,
    now: () => BOARD_NOW,
  });
  const store = service.store();
  assert.ok(store);
  const added = store.add(BOARD_ASKED);
  const id = added.errand?.id ?? '';
  store.start(id);
  store.finish(id, BOARD_DONE);
  await boardSettle(store);
  const { fake, reads } = rig();
  fake.seedChat(channel('c1'));
  let turns = 0;
  const errandTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: {
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ outcome: 'spoke' });
      },
    },
    errands: service,
    now: () => BOARD_NOW,
    // A retry is never due here: the timer is a stand-in that never runs the retry.
    setTimer: () => setTimeout(() => {}, 0),
    log: BOARD_SILENT,
  });
  const delivery = (): ReturnType<typeof errandDoneEvent> => {
    const errand = store.get(id);
    assert.ok(errand);
    return errandDoneEvent(errand, () => BOARD_NOW);
  };
  await errandTurns.onEvent(delivery());
  await errandTurns.onEvent(delivery());
  await boardSettle(store);
  assert.equal(turns, 1);
  assert.equal(closingLines(memory.memoryDb, id), 1);
});

test('the errand store keeps the count of failed searches on the finished errand', () => {
  // Catches: the count lost between the runner and the stored errand, so the notice never reaches the persona.
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-sf-'), 'data') });
  try {
    const config = { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } };
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = createErrandStores({ memoryDb: memory.memoryDb, config: () => config, log: quiet }).get();
    assert.ok(store, 'a store');
    const { errand } = store.add({
      agent: 'scout',
      goal: 'find the notes',
      requester: { accountId: '7', kind: 'member' },
      // The lead: an errand's origin names its place (`placeId`), as the store's type says.
      origin: { placeId: 'c1', messageId: 'm1' },
      scope: 'group',
    });
    const id = String(loose(errand).id);
    store.start(id);
    const done = store.finish(id, { status: 'done', result: { text: 'ok', searchFailures: 2 } });
    assert.equal(loose(loose(done).result).searchFailures, 2);
  } finally {
    void memory.close();
  }
});

const WRITE_NOW = Date.parse('2026-11-10T10:00:00Z');

const writeStatusOf = (db: Db, id: string): unknown =>
  db.prepare('SELECT status FROM board_tasks WHERE id = ?').get(id)?.status;

const WRITE_OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of WRITE_OPENED) await memory.close();
});

test('the errand store writes through the errand kind of the service', async () => {
  const memory = openTestMemorySync({ dataDir: deliveryTempDataDir('nep-errand-kind-'), now: () => WRITE_NOW });
  WRITE_OPENED.push(memory);
  // The service has no unit write.
  const { memoryDb } = memory;
  const journal = createJournal({ dataDir: memory.dataDir, now: () => WRITE_NOW, memoryDb });
  const store = createErrandStore({
    memoryDb,
    journal,
    now: () => WRITE_NOW,
    config: () => ({ errands: { maxOpen: 3 }, agents: { scout: { daily: { tasks: 5 } } } }),
  });
  const added = store.add({
    agent: 'scout',
    goal: 'find the opening hours',
    requester: { kind: 'member', accountId: 'u1' },
    origin: { placeId: 'c1', messageId: 'm1' },
    scope: 'group',
  });
  const id = added.ok ? String(added.errand.id) : '';
  store.start(id);
  store.finish(id, { status: 'done', result: { text: 'eight', sources: [], files: [] }, usage: { usd: 0 } });
  assert.equal((await store.flush()).waiting, 0);
  const db = dbOf(memory.memoryDb.readHandle() as never);
  assert.equal(writeStatusOf(db, id), 'done');
  const lines = db.prepare("SELECT count(*) AS n FROM day WHERE writer = 'journal' AND work_id = ?").get(id)?.n;
  // Queued, started, and the closing line written with the end.
  assert.equal(Number(lines), 3);
});
