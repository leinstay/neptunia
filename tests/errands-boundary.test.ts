// The errand rename at the boundary of what is stored: a database at schema v13 holds the errands and intentions the way the
// code before the rename wrote them (units `tasks.json` and `tasks.jsonl`, the fields `awaitingTaskId`, `lastTaskId`,
// `outcome.taskId`, the notes `task-missing` and `task-<state>`), a queued wake in `inner.json` carries `taskId`, and a
// local config grants her `task.run`. One open and one start of the code after the rename must leave her history as it was
// and give her everything the old files held under the new names. The pieces run for real: the schema migration, the
// memory database service, the errand and intention stores and services, the inner life's scheduler and the call
// normalizer; the turn runner and the errand runner's client are fakes. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { errandsBlockText } from '../src/errands/blocks.ts';
import { createInnerLife } from '../src/behavior/inner.ts';
import { wakeBlockText } from '../src/behavior/wake.ts';
import { createEventDoor } from '../src/interface/door.js';
import { intentionsBlockText } from '../src/intentions/blocks.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { currentToolName, SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { normalizeCalls } from '../src/tools/tool-calls.ts';
import '../src/tools/impl/index.ts';
import { toolCallsOf } from '../src/llm/openrouter.js';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.js';
import { tempDir } from './fixtures/tmp.js';
import { useIface, world } from './fixtures/turn-world.ts';
import {
  dbOf,
  dumpTables,
  openCurrent,
  openV13,
  putIntentionUnits,
  putTaskUnits,
  type Db,
  type Record13,
  type Row,
} from './fixtures/memory-db/v13-errands.ts';

useIface('fake');
const GUILD = 'g1';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_LABELS: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.join(REPO, 'prompts', 'labels.json'), 'utf8')
) as Record<string, unknown>;

// ---- what the code before the rename stored ---------------------------------------------------------------------------

const errand = (id: string, fields: Record<string, unknown>): Record13 => ({
  id,
  agent: 'scout',
  goal: `look into ${id}`,
  requester: { userId: '100', kind: 'member' },
  origin: { channelId: 'c1', messageId: null },
  scope: 'group',
  state: 'queued',
  createdAt: NOW - 3 * HOUR,
  startedAt: null,
  endedAt: null,
  usage: null,
  result: null,
  error: null,
  seen: false,
  readAt: null,
  resolvedAt: null,
  opId: `op-${id}`,
  ...fields,
});

/** Finished and read, with a file in its result. */
const READ = errand('t0000000a', {
  state: 'done',
  startedAt: NOW - 3 * HOUR + 1,
  endedAt: NOW - 2 * HOUR,
  result: { text: 'the pier', sources: [], files: [{ name: 'a.txt', contentType: 'text/plain', bytes: 3 }] },
  seen: true,
  readAt: NOW - HOUR,
});
/** Done, and her result turn never ran. */
const UNREAD = errand('t0000000b', {
  state: 'done',
  startedAt: NOW - 3 * HOUR + 1,
  endedAt: NOW - 2 * HOUR,
  result: { text: 'the lighthouse', sources: [], files: [] },
});
/** Still running when the core stopped. */
const RUNNING = errand('t0000000c', { state: 'running', startedAt: NOW - HOUR });
const ERRANDS = [READ, UNREAD, RUNNING];
const LINES = ERRANDS.map((item, index) => ({ ...item, at: NOW - (3 - index) * HOUR }));

const intention = (id: string, fields: Record<string, unknown>): Record13 => ({
  id,
  purpose: `purpose of ${id}`,
  provenance: { kind: 'self', channelId: 'c1', scope: 'group' },
  status: 'pending',
  createdAt: NOW - 24 * HOUR,
  updatedAt: NOW - 2 * HOUR,
  dueAt: null,
  every: null,
  expiresAt: NOW + 7 * 24 * HOUR,
  awaitingTaskId: null,
  waitDeadline: null,
  destination: null,
  completionCondition: null,
  chainId: null,
  attend: null,
  history: [{ at: NOW - 24 * HOUR, to: 'pending', by: 'persona' }],
  ...fields,
});

/** Waiting on the running errand. */
const WAIT = intention('i-wait', { status: 'waiting', awaitingTaskId: 't0000000c', waitDeadline: NOW + HOUR });
/** Past its wait deadline before the deploy; its wake was handled. */
const LATE = intention('i-late', { note: 'wait-deadline', lastTaskId: 'tgone0000' });
/** Its errand was gone at the last reconciliation. */
const MISS = intention('i-miss', { note: 'task-missing', lastTaskId: 'tgone0001' });
/** Closed, with the outcome of its errand. */
const DONE = intention('i-done', {
  status: 'done',
  note: 'task-done',
  lastTaskId: 't0000000a',
  outcome: { taskId: 't0000000a', state: 'done', at: NOW - 2 * HOUR },
});
const ARCHIVED = intention('i-old', {
  status: 'expired',
  lastTaskId: 't0000000a',
  outcome: { taskId: 't0000000a', state: 'done', at: NOW - 40 * HOUR },
});

/** The same intentions as the code after the rename holds them. */
const expectedOf = (record: Record13): Record13 => {
  const renamed = (key: string): string =>
    key === 'awaitingTaskId' ? 'awaitingErrandId' : key === 'lastTaskId' ? 'lastErrandId' : key;
  const out: Record13 = { id: record.id };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'outcome') {
      const { taskId, ...rest } = value as Record<string, unknown>;
      out.outcome = { errandId: taskId, ...rest };
    } else if (key === 'note' && record.status !== 'done' && typeof value === 'string' && value.startsWith('task-')) {
      out.note = `errand-${value.slice(5)}`;
    } else out[renamed(key)] = value;
  }
  return out;
};
const EXPECTED_OPEN = [WAIT, LATE, MISS].map(expectedOf);

/** A data directory with the v13 database, the queued wake and the handled one. */
function seededDataDir(): string {
  const dataDir = tempDataDir('nep-errands-boundary-');
  const old = openV13(path.join(dataDir, 'memory.db'));
  putTaskUnits(old.db, GUILD, ERRANDS, LINES);
  putIntentionUnits(old.db, GUILD, [WAIT, LATE, MISS, DONE], [ARCHIVED]);
  // History the rename never touches: her line, a run of the inner life with its action.
  old.db
    .prepare(
      "INSERT INTO sources (id, kind, iface, native_id, text, owner_file, position) VALUES ('said:1', 'said', 'fake', 'm1', 'a line of hers', 'guilds/g1/record/2026-10/2026-10-20.jsonl', 0)"
    )
    .run();
  old.db
    .prepare(
      "INSERT INTO wake_runs (id, kind, trigger, started_at, finished_at, status, outcome) VALUES ('t-old', 'intention_due', 'w1', '2026-10-19T10:00:00.000Z', '2026-10-19T10:01:00.000Z', 'succeeded', 'spoke')"
    )
    .run();
  old.db
    .prepare(
      "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, target, status, at) VALUES ('t-old', 1, 'wake:t-old:1', 'task.run', NULL, 'executed', '2026-10-19T10:00:30.000Z')"
    )
    .run();
  old.close();
  const wake = {
    id: `inner.wake:errand_deadline:i-wait:t0000000c`,
    kind: 'errand_deadline',
    reason: 'wait-deadline',
    intentionIds: ['i-wait'],
    chainId: 'intention:i-wait',
    dueAt: NOW - MINUTE,
    channelId: 'c1',
    privateChat: false,
    taskId: 't0000000c',
  };
  fs.mkdirSync(path.join(dataDir, 'guilds', GUILD), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'guilds', GUILD, 'inner.json'),
    JSON.stringify({
      v: 1,
      queue: [wake],
      handled: { 'inner.wake:errand_deadline:i-late:tgone0000': { at: NOW - 5 * MINUTE, outcome: 'skip' } },
    })
  );
  return dataDir;
}

// ---- the open: what the schema step touches and what it leaves ---------------------------------------------------------

const TOUCHED = [
  'schema_version',
  'files',
  'work',
  'work_events',
  'co_owners',
  'operational',
  'decisions',
  'intentions',
];

test('one open of the v13 database moves the errand units and the intention records and leaves every other row as it was', () => {
  const dataDir = seededDataDir();
  const file = path.join(dataDir, 'memory.db');
  const before = openV13(file);
  const old = dumpTables(before.db);
  before.close();
  const now = openCurrent(file);
  try {
    const after = dumpTables(now.db);
    for (const table of Object.keys(old)) {
      if (TOUCHED.includes(table)) continue;
      // Schema v21 drops the eight reserved ledger_* tables of v1, empty in every database (spec 2026-10-31-stage-6-cut,
      // PR 6a), so they are gone after the open rather than as they were.
      if (table.startsWith('ledger_')) continue;
      assert.deepEqual(after[table], old[table], `the table ${table} is as it was`);
    }
    const sans = (rows: Array<Row> | undefined) =>
      (rows ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'owner_file')));
    assert.deepEqual(sans(after.work), sans(old.work), 'work, record column included, apart from its unit path');
    assert.deepEqual(sans(after.work_events), sans(old.work_events), 'work_events likewise');
    assert.deepEqual(
      new Set((after.work ?? []).map((row) => row.owner_file)),
      new Set([`guilds/${GUILD}/errands.json`])
    );
    assert.deepEqual(
      new Set((after.work_events ?? []).map((row) => row.owner_file)),
      new Set([`guilds/${GUILD}/errands.jsonl`])
    );
    const records = Object.fromEntries((after.intentions ?? []).map((row) => [String(row.id), String(row.record)]));
    for (const wanted of [...EXPECTED_OPEN, expectedOf(DONE)])
      assert.equal(records[wanted.id], JSON.stringify(wanted), `intention ${wanted.id}`);
    assert.equal(records['i-old'], JSON.stringify(ARCHIVED), 'the archived line is history');
  } finally {
    now.close();
  }
});

test('a second open of the same file changes nothing', () => {
  const dataDir = seededDataDir();
  const file = path.join(dataDir, 'memory.db');
  const first = openCurrent(file);
  const settled = dumpTables(first.db);
  first.close();
  const second = openCurrent(file);
  try {
    assert.deepEqual(dumpTables(second.db), settled);
    const moved = dbOf({ db: second.db })
      .prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '%errands.json%'")
      .get();
    assert.equal(moved?.n, 2);
  } finally {
    second.close();
  }
});

// ---- the start: what she reads and what runs ---------------------------------------------------------------------------

type Settings = Record<string, unknown>;
/** What these tests use of an errand store and of the intention service (their JSDoc leaves the results untyped). */
type ErrandStore = {
  recent(count: number): Array<Record13>;
  get(id: string): Record13 | null;
  fileOf(handle: string): { name: string; bytes: number } | null;
};
type IntentionApi = {
  list(guildId: string, options: { all: boolean }): Array<Record13>;
  reconcile(guildId: string): unknown;
};
type Called = Array<{ id: string; state: string }>;

/** One start of the errand stores, the errand service and the intention service over the data directory. */
async function start(dataDir: string) {
  const memory = await openTestMemory({ dataDir, config: { intentions: {} }, now: () => NOW });
  const out = path.join(dataDir, 'out');
  fs.mkdirSync(path.join(out, 't0000000a'), { recursive: true });
  fs.writeFileSync(path.join(out, 't0000000a', 'a.txt'), 'pier');
  const config = (): Settings => ({ agents: { scout: { out } } });
  const stores = createErrandStores({ config, memoryDb: memory.memoryDb, now: () => NOW, log: SILENT });
  const hot = { config: { features: { intentions: true }, bot: { timezone: 'UTC' }, agents: { scout: { out } } } };
  const finished: Called = [];
  const errands = createErrandService({
    client: {},
    stores,
    hot,
    getGuildId: () => GUILD,
    onFinished: (task: { id: string; state: string }, guildId: string) => {
      finished.push({ id: task.id, state: task.state });
      stores.get(guildId)?.markSeen(task.id);
      stores.get(guildId)?.markRead(task.id);
      return Promise.resolve(null);
    },
    defer: (fn: () => void) => queueMicrotask(fn),
    log: SILENT,
    now: () => NOW,
  });
  const intentionStores = createIntentionStores({ now: () => NOW, log: SILENT, memoryDb: memory.memoryDb });
  const intentions = createIntentionService({
    stores: intentionStores,
    hot,
    errands,
    getGuildId: () => GUILD,
    now: () => NOW,
    log: SILENT,
  });
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const stop = async () => {
    await settle();
    await stores.flush({ final: true });
    await intentionStores.flush({ final: true });
    await settle();
    await memory.close();
  };
  return {
    memory,
    stores,
    errands,
    intentions: intentions as IntentionApi,
    storeOf: () => stores.get(GUILD) as ErrandStore,
    finished,
    settle,
    stop,
    hot,
  };
}

const idsOf = (list: Array<{ id: string }>): Array<string> => list.map((item) => item.id).sort();

test('the errand store lists the three errands and resolves a file handle of the finished one', async () => {
  const run = await start(seededDataDir());
  try {
    const store = run.storeOf();
    assert.deepEqual(idsOf(store.recent(100)), ['t0000000a', 't0000000b', 't0000000c']);
    const file = store.fileOf('file:t0000000a/a.txt');
    assert.equal(file?.name, 'a.txt');
    assert.equal(file?.bytes, 3);
  } finally {
    await run.stop();
  }
});

test('the <errands> and <intentions> texts of the migrated records equal the texts built from the seeded values', async () => {
  const run = await start(seededDataDir());
  try {
    const live = errandsBlockText(run.storeOf().recent(100), SHIPPED_LABELS, { now: NOW });
    const seeded = errandsBlockText([READ, UNREAD, RUNNING].slice().reverse(), SHIPPED_LABELS, { now: NOW });
    assert.equal(live, seeded);
    assert.equal(live.includes('t0000000b'), true, 'the unread result is listed');
    const records = run.intentions.list(GUILD, { all: true });
    const byId = new Map(records.map((record) => [record.id, record]));
    const order = ['i-wait', 'i-late', 'i-miss'];
    const text = intentionsBlockText(
      order.map((id) => byId.get(id)),
      SHIPPED_LABELS,
      { now: NOW }
    );
    const wanted = intentionsBlockText(EXPECTED_OPEN, SHIPPED_LABELS, { now: NOW });
    assert.equal(text, wanted);
    assert.equal(text.includes('t0000000c'), true, 'the wait names its errand');
  } finally {
    await run.stop();
  }
});

test('a restart fails the running errand once and moves its waiting intention to pending with errand-failed', async () => {
  const dataDir = seededDataDir();
  const first = await start(dataDir);
  first.errands.start(GUILD);
  first.intentions.reconcile(GUILD);
  await first.settle();
  assert.equal(first.storeOf().get('t0000000c')?.state, 'failed');
  const waited = first.intentions.list(GUILD, { all: true }).find((record) => record.id === 'i-wait');
  assert.deepEqual(
    [waited?.status, waited?.note, (waited?.outcome as Settings | undefined)?.errandId],
    ['pending', 'errand-failed', 't0000000c']
  );
  assert.equal((waited?.outcome as Settings | undefined)?.state, 'failed');
  await first.stop();

  const second = await start(dataDir);
  try {
    second.errands.start(GUILD);
    second.intentions.reconcile(GUILD);
    await second.settle();
    const lines = dbOf(second.memory.memoryDb.readHandle() as { db: object })
      .prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 't0000000c'")
      .get();
    assert.equal(lines?.n, 2, 'the running line and the one failure, no second failure');
  } finally {
    await second.stop();
  }
});

test('the result turn that never ran is opened once, and a second start opens none', async () => {
  const dataDir = seededDataDir();
  const first = await start(dataDir);
  first.errands.start(GUILD);
  await first.settle();
  assert.deepEqual(
    first.finished.map((entry) => entry.id).sort(),
    ['t0000000b', 't0000000c'],
    'the unread one and the one the restart failed'
  );
  await first.stop();
  const second = await start(dataDir);
  try {
    second.errands.start(GUILD);
    await second.settle();
    assert.deepEqual(second.finished, []);
  } finally {
    await second.stop();
  }
});

/** One tick of the inner life over the data directory, its turn runner a fake that keeps the calls. */
async function tick(dataDir: string) {
  const run = await start(dataDir);
  run.errands.start(GUILD);
  run.intentions.reconcile(GUILD);
  await run.settle();
  world().channel({ id: 'c1', name: 'chan-c1', guildId: GUILD, permissions: { send: true } });
  const calls: Array<{ inner: { wake: { items: Array<Settings>; intentions: Array<Record13> } } }> = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: (params: (typeof calls)[number]) => {
      calls.push(params);
      return Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } });
    },
  };
  let inner: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => inner?.onWake(event) }, log: SILENT });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { innerLife: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        heartbeat: { enabled: false },
        caps: { perChain: 3 },
      },
    },
  };
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: run.intentions,
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    // The open imported inner.json's queue into the database (stage 4 cut, the lead's decision 1): the life reads it there.
    memoryDb: run.memory.memoryDb,
    rng: () => 0.5,
    now: () => NOW,
    log: SILENT,
  });
  return { run, inner, calls };
}

test('the queued errand_deadline wake that carried taskId runs once and names its errand as errandId; the handled one never runs', async () => {
  const dataDir = seededDataDir();
  const { run, inner, calls } = await tick(dataDir);
  try {
    const state = inner.state(GUILD) as { queue: Array<Settings> };
    const queued = state.queue[0];
    assert.equal(queued?.errandId, 't0000000c');
    assert.equal(Object.hasOwn(queued ?? {}, 'taskId'), false, 'the old field is dropped');
    await inner.tick();
    assert.equal(calls.length, 1, 'one turn');
    const wake = calls[0]?.inner.wake;
    assert.deepEqual(
      wake?.items.filter((item) => item.kind === 'errand_deadline').map((item) => [item.intentionIds, item.errandId]),
      [[['i-wait'], 't0000000c']]
    );
    const mentioned = (wake?.items ?? []).flatMap((item) => item.intentionIds as Array<string>);
    assert.equal(mentioned.includes('i-late'), false, 'its wake was handled before the deploy');
    // The same wake with one item, once as the turn got it and once as the seeded values give it.
    const item = wake?.items.find((entry) => entry.kind === 'errand_deadline');
    const shown = wakeBlockText({ ...wake, timezone: 'UTC', items: [item] }, SHIPPED_LABELS);
    const seeded = wakeBlockText(
      {
        ...wake,
        timezone: 'UTC',
        items: [{ kind: 'errand_deadline', reason: 'wait-deadline', intentionIds: ['i-wait'], errandId: 't0000000c' }],
      },
      SHIPPED_LABELS
    );
    assert.equal(shown, seeded);
    assert.equal(shown.includes('t0000000c'), true, 'the line names the errand');
    await inner.tick();
    assert.equal(calls.length, 1, 'a second tick wakes nobody again');
  } finally {
    await run.stop();
  }
});

// ---- the call path never translates an old name ---------------------------------------------------------------------

const registry = buildSkills({ table: SKILL_DEFINITIONS });

test('an answer that calls task_run (native) or task.run (text) gets unknown-skill and the name as it was written', () => {
  const nativeCalls = toolCallsOf([
    { id: 'c1', function: { name: 'task_run', arguments: '{"agent":"scout","goal":"x"}' } },
  ]);
  const [native] = normalizeCalls({ calls: nativeCalls, registry, step: 1 });
  assert.deepEqual([native?.problem, native?.name], ['unknown-skill', 'task_run']);
  const [text] = normalizeCalls({
    calls: [{ id: null, name: 'task.run', arguments: '{}', parsed: {}, parseError: null }],
    transport: 'text',
    registry,
    step: 1,
  });
  assert.deepEqual([text?.problem, text?.name], ['unknown-skill', 'task.run']);
  assert.equal(registry.has('task.run'), false);
  assert.equal(registry.has('errand.run'), true);
});

test('the same call under the new name is a call of hers on both transports', () => {
  const [native] = normalizeCalls({
    calls: toolCallsOf([{ id: 'c1', function: { name: 'errand_run', arguments: '{"agent":"scout","goal":"x"}' } }]),
    registry,
    step: 1,
  });
  assert.deepEqual([native?.problem, native?.name], [null, 'errand.run']);
  const [text] = normalizeCalls({
    calls: [{ id: null, name: 'errand.run', arguments: '{}', parsed: { agent: 'scout', goal: 'x' }, parseError: null }],
    transport: 'text',
    registry,
    step: 1,
  });
  assert.deepEqual([text?.problem, text?.name], [null, 'errand.run']);
});

test('a journal that wrote the old names is read under the new ones, and any other name comes back as it is', () => {
  assert.deepEqual(
    ['task.run', 'task.status', 'task.read', 'task.resolve', 'task.cancel', 'task.list'].map(currentToolName),
    ['errand.run', 'errand.status', 'errand.read', 'errand.resolve', 'errand.cancel', 'errand.list']
  );
  assert.deepEqual(['intent.set', 'intent.update', 'intent.cancel', 'intent.list'].map(currentToolName), [
    'intention.set',
    'intention.update',
    'intention.cancel',
    'intention.list',
  ]);
  assert.equal(currentToolName('skills.describe'), 'tools.describe');
  assert.equal(currentToolName('message.create'), 'message.create');
  assert.equal(currentToolName(null), null);
});

test('a local config that grants task.run to her still grants her errand.run after the load', async () => {
  const { readConfig } = await import('../src/config.js');
  const { grantedSkillNames } = await import('../src/tools/discovery.ts');
  const { skillRegistry } = await import('../src/tools/registry.ts');
  const privateDir = tempDir('nep-boundary-private-');
  fs.writeFileSync(
    path.join(privateDir, 'config.local.json'),
    JSON.stringify({
      bot: { owners: ['o1'], access: { 'task.run': { everyone: false, roles: [], users: ['self-1'] } } },
    })
  );
  const config = readConfig(REPO, { privateDir }) as Settings;
  assert.equal(grantedSkillNames({ config, selfId: 'self-1', registry: skillRegistry() }).includes('errand.run'), true);
});

/** Keeps the type of the helper used above in the signature of a database handle. */
export type { Db };
