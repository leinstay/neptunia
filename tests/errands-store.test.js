// Tests for src/errands/store.ts: the persona's errand tasks, per guild, in the memory database of a
// temp data/ directory. A task moves queued -> running -> done | failed | cancelled, each one a task of the board's
// errand lane with one status event per transition, the caps refuse with their codes (open at
// once, tasks and dollars per UTC day), the journal gets one operation per task with counts
// only, and a file handle resolves only to a file the task's result lists.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrandStore, fileHandle, parseFileHandle } from '../src/errands/store.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';
import { openTestMemorySync } from './fixtures/memory-db/service.js';
import { readBoard } from '../src/board/board.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-17T10:00:00Z');

function tempDataDir() {
  return tempDir('errands-store-');
}

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return MEMORY.get(dataDir).memoryDb;
}

/**
 * Task `id` as the board of `dataDir` shows it, once `store`'s writes landed.
 * @returns {Promise<import('../src/board/board.ts').TaskView>}
 */
async function boardTask(store, dataDir, id) {
  await store.flush();
  return readBoard(memoryOf(dataDir).readHandle().db, () => T0).show(id);
}

/**
 * The statuses a board task passed through, in order.
 * @param {import('../src/board/board.ts').TaskView} view
 */
const statusesOf = (view) => view.events.filter((event) => event.type === 'status').map((event) => event.new);

function makeStore({
  dataDir = tempDataDir(),
  clock = { t: T0 },
  errands = {},
  agents = {},
  journal = null,
  journalOn = true,
} = {}) {
  const config = {
    features: { journal: journalOn },
    errands: { maxOpen: 3, ...errands },
    agents: {
      scout: { daily: { tasks: 5 }, out: '/var/lib/agent-scout/out' },
      server: { daily: { tasks: 2 }, out: '/var/lib/agent-server/out' },
      ...agents,
    },
  };
  let n = 0;
  const store = createErrandStore({
    dataDir,
    guildId: 'g1',
    now: () => clock.t,
    config: () => config,
    journal,
    memoryDb: memoryOf(dataDir),
    uuid: () => `${(n += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
  });
  return { store, dataDir, clock, config };
}

const asked = {
  agent: 'scout',
  goal: 'find the release notes',
  requester: { userId: 'u1', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group',
};

// PR 6d: the errands live on the board, so the unit errands.json and its lines in errands.jsonl became one task of the
// errand lane and its status events; the test checks the same write and read-back there.
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
    assert.deepEqual(task.requester, { userId: 'u1', kind: 'member' });
    assert.deepEqual(task.origin, { channelId: 'c1', messageId: 'm1' });
    assert.equal(task.scope, 'group');
    assert.equal(task.createdAt, T0);
    assert.equal(task.seen, false);
    assert.equal(task.result, null);
    const view = await boardTask(store, dataDir, task.id);
    assert.deepEqual([view.task.lane, view.task.status], ['errand', 'approved']);
    assert.deepEqual(statusesOf(view), ['approved']);
    // A second store over the same directory reads the list back.
    const again = createErrandStore({ dataDir, guildId: 'g1', memoryDb: memoryOf(dataDir), now: () => T0 });
    assert.equal(again.get(task.id).goal, 'find the release notes');
  });
});

// PR 6d: the transitions errands.jsonl held are the board task's status events; the test reads them there.
test('task store: queued -> running -> done; the end is written once, a late one ignored', async () => {
  await withCapturedLogs(async () => {
    const { store, dataDir, clock } = makeStore();
    const { errand: task } = store.add(asked);
    clock.t += 1000;
    assert.equal(store.start(task.id).state, 'running');
    assert.equal(store.start(task.id), null, 'only a queued task starts');
    assert.deepEqual(
      store.open().map((t) => t.id),
      [task.id]
    );
    clock.t += 5000;
    const done = store.finish(task.id, {
      status: 'done',
      result: { text: 'here', sources: ['https://example.org'], files: [] },
      usage: { usd: 0.25, steps: 3 },
    });
    assert.equal(done.state, 'done');
    assert.equal(done.endedAt, T0 + 6000);
    assert.equal(done.result.text, 'here');
    assert.equal(done.usage.usd, 0.25);
    assert.equal(done.error, null);
    assert.equal(Object.hasOwn(done.result, 'filesDropped'), false, 'none held back, no key');
    assert.equal(store.finish(task.id, { status: 'failed' }), null);
    assert.deepEqual(store.open(), []);
    assert.deepEqual(
      store.unseen().map((t) => t.id),
      [task.id]
    );
    assert.equal(store.markSeen(task.id).seen, true);
    assert.deepEqual(store.unseen(), []);
    assert.equal(store.today('scout').usd, 0.25);
    assert.deepEqual(statusesOf(await boardTask(store, dataDir, task.id)), ['approved', 'in_progress', 'done']);
  });
});

test('task store: the files the runner held back are kept as names only', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.start(task.id);
    const done = store.finish(task.id, {
      status: 'done',
      result: {
        text: 'here',
        filesDropped: [
          { name: 'x.env', reason: 'secret' },
          { name: 'a.txt', reason: 'withheld' },
          { name: 'b', reason: 'other' },
        ],
      },
    });
    assert.deepEqual(done.result.filesDropped, ['x.env', 'a.txt']);
  });
});

test("task store: a cancel closes an open task; the runner's later end changes nothing", async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.start(task.id);
    const cancelled = store.cancel(task.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.error, 'cancelled');
    assert.equal(store.finish(task.id, { status: 'done', result: { text: 'late' } }), null);
    assert.equal(store.get(task.id).state, 'cancelled');
    assert.equal(store.cancel(task.id), null);
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
    const server = { ...asked, agent: 'server', requester: { userId: 'owner', kind: 'owner' } };
    const s1 = store.add(server).errand;
    store.finish(s1.id, { status: 'done', usage: { usd: 0.1 } });
    const s2 = store.add(server).errand;
    store.finish(s2.id, { status: 'done', usage: { usd: 0.1 } });
    assert.deepEqual(store.add(server), { ok: false, code: 'cap-tasks' });
    // scout: what a day's tasks cost refuses nothing.
    const w = store.add(asked).errand;
    store.finish(w.id, { status: 'done', usage: { usd: 500 } });
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
  const lines = [];
  const journal = { action: async (guildId, record) => lines.push({ guildId, ...record }) };
  await withCapturedLogs(async () => {
    const { store } = makeStore({ journal });
    const { errand: task } = store.add(asked);
    store.start(task.id);
    store.finish(task.id, {
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
      assert.equal(line.channelId, 'c1');
      assert.deepEqual(line.participants, ['u1']);
      assert.deepEqual(line.sourceMessageIds, ['m1']);
    }
    assert.deepEqual(lines[2].result, {
      errandId: task.id,
      state: 'done',
      chars: 18,
      sources: 2,
      files: 1,
      usage: { usd: 0.02, steps: 2, seconds: 0 },
    });
    const all = JSON.stringify(lines);
    assert.ok(!all.includes('release notes') && !all.includes('secret answer'), 'never the goal or the result');
    // A failure closes with its code; the journal off writes nothing.
    const failedTask = store.add(asked).errand;
    store.finish(failedTask.id, { status: 'failed', error: 'withheld-path' });
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.at(-1).phase, 'failed');
    assert.equal(lines.at(-1).result.code, 'withheld-path');
  });
  const quiet = [];
  await withCapturedLogs(() => {
    const { store } = makeStore({ journal: { action: async (g, r) => quiet.push(r) }, journalOn: false });
    store.add(asked);
  });
  assert.deepEqual(quiet, []);
});

test("task store: a DM task journals into the requester's private layer", async () => {
  const lines = [];
  await withCapturedLogs(async () => {
    const { store } = makeStore({ journal: { action: async (guildId, record) => lines.push(record) } });
    store.add({ ...asked, scope: 'dm', origin: { channelId: 'dm1', messageId: 'm9' } });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(lines[0].privateUserId, 'u1');
  assert.equal(lines[0].channelId, undefined);
});

test('task store: a file handle resolves only to a file the task lists, inside its out directory', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { errand: task } = store.add(asked);
    store.finish(task.id, {
      status: 'done',
      result: {
        text: 'ok',
        files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 1234 }],
      },
    });
    const handle = fileHandle(task.id, 'meme.png');
    assert.equal(handle, `file:${task.id}/meme.png`);
    assert.deepEqual(parseFileHandle(handle), { id: task.id, name: 'meme.png' });
    const file = store.fileOf(handle);
    assert.equal(
      file.path,
      path.resolve('/var/lib/agent-scout/out', task.id, 'meme.png'),
      'the out directory, never the path the runner wrote'
    );
    assert.equal(file.contentType, 'image/png');
    assert.equal(file.bytes, 1234);
    assert.equal(store.fileOf(`file:${task.id}/other.png`), null);
    assert.equal(store.fileOf('file:tnope/meme.png'), null);
    assert.equal(store.fileOf(`file:${task.id}/../meme.png`), null);
    assert.equal(parseFileHandle(`file:${task.id}/..`), null);
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
    store.start(b.id);
    assert.deepEqual(
      store.recent(2).map((t) => t.id),
      [c.id, b.id]
    );
    assert.equal(store.failOpen('restarted'), 3);
    assert.deepEqual(store.open(), []);
    for (const id of [a.id, b.id, c.id]) {
      assert.equal(store.get(id).state, 'failed');
      assert.equal(store.get(id).error, 'restarted');
    }
  });
});

// PR 6d: the mark is written to the errand's board task (its metadata), where errands.json held it before.
test("task store: a finished task's files expire once the runner removed its directory; the handle then names nothing", async () => {
  await withCapturedLogs(async () => {
    const out = tempDir('errands-out-');
    const { store, dataDir } = makeStore({ errands: { maxOpen: 5 }, agents: { scout: { daily: { tasks: 5 }, out } } });
    const files = [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 12 }];
    const kept = store.add(asked).errand;
    const gone = store.add(asked).errand;
    const bare = store.add(asked).errand;
    const open = store.add(asked).errand;
    for (const id of [kept.id, gone.id]) store.finish(id, { status: 'done', result: { text: 'ok', files } });
    store.finish(bare.id, { status: 'done', result: { text: 'no files' } });
    fs.mkdirSync(path.join(out, kept.id));
    // The directory of `gone` was never there (as after the runner's sweep), nor that of `bare` or `open`.
    assert.equal(store.get(gone.id).filesExpired, true);
    assert.equal(store.get(kept.id).filesExpired, undefined);
    assert.equal(store.get(bare.id).filesExpired, undefined, 'a task without files has nothing to expire');
    assert.equal(store.get(open.id).filesExpired, undefined, 'an open task is never marked');
    assert.equal(store.fileOf(fileHandle(gone.id, 'meme.png')), null);
    assert.ok(store.fileOf(fileHandle(kept.id, 'meme.png')));
    assert.ok(store.unseen().find((t) => t.id === gone.id).filesExpired);
    const saved = (await boardTask(store, dataDir, gone.id)).task.metadata.errand;
    assert.equal(saved.filesExpired, true, 'written to the board');
    assert.equal(store.expireFiles(), 0, 'marked once');
    fs.rmSync(path.join(out, kept.id), { recursive: true });
    assert.equal(store.recent(10).find((t) => t.id === kept.id).filesExpired, true);
  });
});

test('task store: no out dir at all (no runner on this host) expires nothing', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore({
      agents: { scout: { daily: { tasks: 5 }, out: path.join(os.tmpdir(), 'errands-no-such-out-dir') } },
    });
    const { errand: task } = store.add(asked);
    store.finish(task.id, { status: 'done', result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] } });
    assert.equal(store.expireFiles(), 0);
    assert.equal(store.get(task.id).filesExpired, undefined);
  });
});

// PR 6d: the ledger's id is written to the errand's board task, the one record that replaced errands.json and the
// transition lines of errands.jsonl; the test reads it there and from a second store.
test("task store: setLedgerId keeps the ledger's id on the task (written to the board, kept by the later transitions); none for an unknown task", async () => {
  await withCapturedLogs(async () => {
    const { store, dataDir } = makeStore();
    const { errand: task } = store.add(asked);
    assert.equal(Object.hasOwn(task, 'ledgerId'), false, 'optional: absent until the ledger answers');
    assert.equal(store.setLedgerId(task.id, 'L7').ledgerId, 'L7');
    assert.equal(store.setLedgerId(task.id, 12).ledgerId, '12');
    assert.equal(store.setLedgerId(task.id, 'L7').ledgerId, 'L7');
    assert.equal(store.setLedgerId('tnone', 'L8'), null);
    assert.equal(store.setLedgerId(task.id, ''), null);
    store.start(task.id);
    const view = await boardTask(store, dataDir, task.id);
    assert.deepEqual([view.task.status, view.task.metadata.errand.ledgerId], ['in_progress', 'L7']);
    // A second store over the same directory reads it back.
    assert.equal(
      createErrandStore({ dataDir, guildId: 'g1', memoryDb: memoryOf(dataDir), now: () => T0 }).get(task.id).ledgerId,
      'L7'
    );
  });
});

// PR 6d: after a restart the spend records come from the errands on the board, where errands.jsonl gave them before.
test('task store: costs and the daily caps read the same spend records, rebuilt from the board after a restart', async () => {
  await withCapturedLogs(async () => {
    const dataDir = tempDataDir();
    const clock = { t: T0 };
    const { store, config } = makeStore({ dataDir, clock });
    const old = store.add(asked).errand;
    store.finish(old.id, { status: 'done', usage: { input: 5000, output: 500, usd: 0.3 } });
    clock.t += 3 * DAY;
    const a = store.add(asked).errand;
    store.start(a.id);
    store.finish(a.id, { status: 'done', usage: { input: 1000, output: 100, usd: 0.6, steps: 2 } });
    const b = store.add({ ...asked, requester: { userId: 'u2', kind: 'member' } }).errand;
    store.finish(b.id, { status: 'failed', error: 'x', usage: { input: 2000, output: 200, usd: 0.3 } });
    const costs = store.costs(['scout', 'dev']);
    assert.deepEqual(Object.keys(costs), ['scout', 'dev']);
    assert.deepEqual(costs.scout.today, { runs: 2, input: 3000, output: 300, usd: 0.8999999999999999 });
    assert.equal(costs.scout.last7.runs, 3);
    assert.equal(costs.dev.last30.runs, 0);
    assert.deepEqual(
      store.today('scout'),
      { tasks: costs.scout.today.runs, usd: costs.scout.today.usd, caps: { tasks: 5 } },
      "the caps read the costs' today"
    );
    const c = store.add(asked).errand;
    store.finish(c.id, { status: 'done', usage: { usd: 0.2 } });

    // A restart: the board gives the same numbers back.
    await store.flush();
    const again = createErrandStore({
      dataDir,
      guildId: 'g1',
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
    const hers = {
      ...asked,
      goal: brief,
      requester: { userId: 'u1', kind: 'member' },
      origin: { channelId: 'c1', messageId: 'm1', turnId: 'turn-7' },
      idempotencyKey: 'turn-7.1:0',
    };
    const first = store.add(hers);
    assert.equal(first.ok, true);
    assert.equal(first.errand.goal, brief.trim(), 'the brief as she wrote it');
    assert.deepEqual(first.errand.origin, { channelId: 'c1', messageId: 'm1', turnId: 'turn-7' });
    assert.equal(first.errand.idempotencyKey, 'turn-7.1:0');
    const again = store.add({ ...hers, goal: 'κάτι άλλο' });
    assert.deepEqual(
      [again.ok, again.duplicate, again.errand.id, again.errand.goal],
      [true, true, first.errand.id, brief.trim()],
      'the same call: the same task, even past the open cap'
    );
    assert.equal(store.recent(10).length, 1);
    // Another call of the same turn is another errand (here refused by the cap of one open task).
    assert.deepEqual([store.add({ ...hers, idempotencyKey: 'turn-7.1:1' }).ok, store.recent(10).length], [false, 1]);
    // A command brings neither: no turn, no key.
    const { store: other } = makeStore();
    const plain = other.add(asked).errand;
    assert.deepEqual(plain.origin, { channelId: 'c1', messageId: 'm1' });
    assert.equal('idempotencyKey' in plain, false);
  });
});
