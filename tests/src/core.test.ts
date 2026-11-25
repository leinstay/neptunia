// Tests for src/core.ts: the core that `startCore` builds over temporary data folders, a scripted model and the
// tracked prompts. Nothing calls a provider. The memory database is read through a second, read-only connection,
// because the core holds the writer lock. Short folders: a Unix socket path is limited to 108 bytes.
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs, {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.ts';
import { addClient } from '../../src/setup/clients.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { onLog } from '../../src/log.ts';
import { interfaceNamesOf } from '../../src/memory/db/frame-reads.ts';
import { lockPathOf, openMemoryDb, acquireLock } from '../../src/memory/db/open.ts';
import { applyWakeQueueWrite } from '../../src/memory/db/wake-queue.ts';
import { connectSocket } from '../../src/protocol/wire.ts';
import { createFakeAdapter } from '../../scripts/lib/fake.ts';
import { start } from '../../scripts/lib/fake-interface.ts';
import { ANSWER, channelInfo, deliver, lineEvent, until as fakeUntil } from '../fixtures/core-over-fake.ts';
import { withCapturedLogs } from '../fixtures/capture-logs.ts';
import { chainsOf } from '../fixtures/chains.ts';
import {
  mention as noReplayMention,
  settle,
  startUnitsCore as noReplayStartUnitsCore,
  startedUnit as noReplayStartedUnit,
  postedOnce as noReplayPostedOnce,
  withRig as noReplayWithRig,
  ANSWER as CUTOVER_ANSWER,
  until as cutoverUntil,
  FAKE_CLIENT,
  query as lockQuery,
  seenIds,
} from '../fixtures/core-units.ts';
import net from 'node:net';
import { endEvent, encodeLine, pongEvent } from '../../src/agent-runner/protocol.ts';
import type { Llm as CutoverLlm, Settings as CutoverSettings, Dirs as LockDirs, Rig } from '../fixtures/core-units.ts';
import { call, toolAnswer } from '../fixtures/tool-answers.ts';
import { tempDir } from '../fixtures/tmp.ts';
import type { InstanceCommand, InstanceReady, InstanceReply } from '../fixtures/instance-protocol.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

// --- the core as its own process, the interfaces as units ---------------------------------------------------------

// `startCore` runs in the test process with no interface. An interface runs the way a unit runs it:
// `bin/neptunia.ts interface run fake --interfaces-dir tests/fixtures/interfaces` in a child process, which reads its
// token from `<private>/clients/fake.token`, connects to `<data>/run/core.sock` and serves the fake interface of
// tests/fixtures/interfaces/fake/index.ts. The test drives that child over its IPC channel. The token is written by
// src/setup/clients.ts, as setup writes it. No Discord object is reached.
type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...args: Array<unknown>): Array<Row> } };
type Settings = Record<string, unknown>;
type Core = Awaited<ReturnType<typeof startCore>>;
type LogEntry = Record<string, unknown>;

const BIN = join(REPO, 'bin', 'neptunia.ts');
const INTERFACES_DIR = join(REPO, 'tests', 'fixtures', 'interfaces');
const T0 = Date.parse('2026-10-31T12:00:00Z');

/** The private layer of every rig: units mode, the settle wait and typing off, every optional behaviour off. */
const BASE_CONFIG: Settings = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  interfaces: { mode: 'units', drainMs: 2000 },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: false,
    offlineCatchUp: false,
    diary: false,
    mediaDescriptions: false,
    missedAnswers: false,
    channelRoute: false,
    recall: false,
    memoryPrefetch: false,
    channelPull: false,
    elsewhere: false,
    speech: false,
    pauseNotice: false,
    wakes: false,
  },
};

const isRecord = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function merged(base: Settings, extra: Settings): Settings {
  const out: Settings = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const old = out[key];
    out[key] = isRecord(old) && isRecord(value) ? merged(old, value) : value;
  }
  return out;
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Dirs = {
  root: string;
  dataDir: string;
  privateDir: string;
  paths: { rootDir: string; privateDir: string; dataDir: string };
};

// Short folders: a Unix socket path is limited to 108 bytes.
function folders(config: Settings = {}): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  const dataDir = join(root, 'd');
  // Runtime privateDir aliases the prepared persona data root.
  const privateDir = dataDir;
  mkdirSync(join(privateDir, 'config'), { recursive: true });
  writeFileSync(join(privateDir, 'config', 'config.json'), JSON.stringify(merged(BASE_CONFIG, config)));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

/** The client `fake` of kind interface, its token in `<private>/clients/fake.token`, written as setup writes it. */
function addFakeClient(privateDir: string): void {
  addClient(privateDir, 'fake', { kind: 'interface', iface: 'fake', permissions: [] });
}

/** The scripted model: every request is answered `<msg>` + ANSWER and kept. */
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    // The door asks the address classifier first, which says yes and is not recorded.
    complete: (messages: unknown, given?: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}
type Llm = ReturnType<typeof scriptedLlm>;

/** The core with no interface of its own. */
function startUnitsCore(dirs: Dirs, llm: Llm, now?: () => number): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    ...(now === undefined ? {} : { now }),
  });
}

function query(dirs: Dirs, sql: string, ...args: Array<unknown>): Array<Row> {
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'), { readOnly: true });
  try {
    return (handle.db as Db)
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  } finally {
    handle.close();
  }
}

/** The log entries of the core while `body` runs, as they are written. */
async function watchingLogs<T>(body: (logs: Array<LogEntry>) => Promise<T>): Promise<T> {
  const logs: Array<LogEntry> = [];
  const stop = onLog((entry: object) => {
    logs.push({ ...entry });
  });
  try {
    const { result } = await withCapturedLogs(() => body(logs));
    return result;
  } finally {
    stop();
  }
}

const helloRefused = (logs: ReadonlyArray<LogEntry>, reason: string): boolean =>
  logs.some((entry) => entry.msg === 'link: hello refused' && entry.reason === reason);

type Reply = Record<string, unknown> & { op: string };

/** One `neptunia interface run fake` child, driven over IPC. */
type Unit = {
  child: ChildProcess;
  output(): string;
  /** Sends a request and resolves with the first reply of `op` to it. */
  ask(request: Record<string, unknown>, op: string): Promise<Reply>;
  /** Resolves with the next message of `op` the child tells by itself. */
  told(op: string): Promise<Reply>;
  /** Emits a mention of the persona and resolves once the child's emit returned. */
  emit(event: unknown): Promise<{ acked: Promise<string> }>;
  posted(chatId: string): Promise<Array<string>>;
  kill(signal?: NodeJS.Signals): Promise<void>;
};

function spawnUnit(dirs: Dirs): Unit {
  const child = spawn(process.execPath, [BIN, 'interface', 'run', 'fake', '--interfaces-dir', INTERFACES_DIR], {
    cwd: REPO,
    env: { ...process.env, NEPTUNIA_DATA_DIR: dirs.dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const listeners = new Set<(message: Reply) => void>();
  child.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message.op !== 'string') return;
    for (const listener of [...listeners]) listener(message as Reply);
  });
  let nextId = 0;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  function waitFor(match: (message: Reply) => boolean, what: string, ms = 8000): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`the unit never told ${what}; its output:\n${out.slice(-2000)}`));
      }, ms);
      const listener = (message: Reply): void => {
        if (!match(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
      void exited.then(() => {
        if (!listeners.has(listener)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        reject(new Error(`the unit exited before it told ${what}; its output:\n${out.slice(-2000)}`));
      });
    });
  }

  const unit: Unit = {
    child,
    output: () => out,
    ask(request, op) {
      nextId += 1;
      const id = nextId;
      const answer = waitFor((message) => message.id === id && message.op === op, `${op} for request ${id}`);
      child.send({ ...request, id });
      return answer;
    },
    told: (op) => waitFor((message) => message.op === op && message.id === undefined, op),
    async emit(event) {
      nextId += 1;
      const id = nextId;
      const acked = waitFor(
        (message) => message.id === id && message.op === 'acked',
        `the ack of request ${id}`,
        15000
      ).then((message) => String(message.status));
      // A rejection of an ack nobody awaits must not end the run.
      acked.catch(() => {});
      const queued = waitFor((message) => message.id === id && message.op === 'queued', `queued for request ${id}`);
      child.send({ id, op: 'emit', event });
      await queued;
      return { acked };
    },
    async posted(chatId) {
      const reply = await unit.ask({ op: 'posted', chatId }, 'posted');
      return Array.isArray(reply.texts) ? reply.texts.map(String) : [];
    },
    async kill(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      const forced = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(forced);
    },
  };
  return unit;
}

/** A unit that started and holds the chat c1. */
async function startedUnit(dirs: Dirs): Promise<Unit> {
  const unit = spawnUnit(dirs);
  await unit.told('started');
  await unit.ask({ op: 'seed-chat', info: channelInfo('c1') }, 'done');
  return unit;
}

const mention = (id: string, text: string, at = Date.now()) => lineEvent({ id, text, at, mention: true });

/** Runs `body` over fresh folders, stopping every unit and core it registered and removing the folders after. */
async function withRig(
  config: Settings,
  body: (rig: { dirs: Dirs; llm: Llm; units: Array<Unit>; cores: Array<Core>; logs: Array<LogEntry> }) => Promise<void>
): Promise<void> {
  const dirs = folders(config);
  addFakeClient(dirs.privateDir);
  const llm = scriptedLlm();
  const units: Array<Unit> = [];
  const cores: Array<Core> = [];
  try {
    await watchingLogs(async (logs) => {
      try {
        await body({ dirs, llm, units, cores, logs });
      } finally {
        for (const unit of units) await unit.kill();
        for (const core of cores) await core.stop();
      }
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

test('a core started with no interface runs a heartbeat turn and records the wake handled', async () => {
  // Sixty clock minutes pass in each real second, so a heartbeat one minute out comes within the wait.
  const realStart = Date.now();
  const now = (): number => T0 + (Date.now() - realStart) * 60;
  await withRig(
    {
      features: { wakes: true, intentions: false },
      memoryDb: { wakeRuns: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 1,
        review: { enabled: false },
      },
      heartbeat: { enabled: true, schedule: 'every 1m', jitterMinutes: 0 },
    },
    async ({ dirs, llm, cores }) => {
      cores.push(await startUnitsCore(dirs, llm, now));
      await until(
        () => query(dirs, "SELECT 1 FROM wakes WHERE kind = 'heartbeat' AND state = 'handled'").length > 0,
        'a handled heartbeat wake',
        10000
      );
      assert.ok(llm.requests.length >= 1, 'the heartbeat turn asked the model');
    }
  );
});

/** What `unit` posted to c1 once it posted `count` texts, or after the wait. */
async function postedOnce(unit: Unit, count: number): Promise<Array<string>> {
  let posted: Array<string> = [];
  for (let i = 0; i < 160; i += 1) {
    posted = await unit.posted('c1');
    if (posted.length >= count) break;
    await pause(50);
  }
  return posted;
}

test("an interface unit connects with its token, delivers a message and posts the persona's reply", async () => {
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const { acked } = await unit.emit(mention('m1', 'hello bot'));
    assert.equal(await acked, 'ok');
    await until(() => llm.requests.length === 1, 'the turn of m1');
    const posted = await postedOnce(unit, 1);
    assert.deepEqual(posted, [ANSWER]);
    // The catalog retains native message IDs while sources.native_id stores an opaque family key.
    assert.deepEqual(
      query(
        dirs,
        `SELECT f.message_id AS native_id FROM sources s
        LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
        WHERE s.kind = 'seen'`
      ).map((row) => row.native_id),
      ['m1']
    );
  });
});

// The interface killed while the core runs.
test('a unit killed and started again keeps the link, and neither message is answered twice', async () => {
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const first = await startedUnit(dirs);
    units.push(first);
    assert.equal(await (await first.emit(mention('m1', 'hello bot'))).acked, 'ok');
    assert.deepEqual(await postedOnce(first, 1), [ANSWER]);
    await first.kill('SIGKILL');

    const second = await startedUnit(dirs);
    units.push(second);
    assert.equal(await (await second.emit(mention('m2', 'are you there'))).acked, 'ok');
    assert.deepEqual(await postedOnce(second, 1), [ANSWER], 'the reply to m2 reaches the new process');
    await pause(300);
    assert.deepEqual(await second.posted('c1'), [ANSWER], 'the reply to m1 is not sent again');
    assert.equal(llm.requests.length, 2, 'one turn for each message');
  });
});

// An event that waited in the outbox of a process that died.
test('an event queued while the core was down survives the kill of its unit as history, with no turn over it', async () => {
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    const core = await startUnitsCore(dirs, llm);
    const first = await startedUnit(dirs);
    units.push(first);
    assert.equal(await (await first.emit(mention('m1', 'hello bot'))).acked, 'ok');
    assert.deepEqual(await postedOnce(first, 1), [ANSWER]);
    await core.stop();

    // The unit keeps the event in its outbox under its data folder; the process then dies before any core takes it.
    await first.emit(mention('m2', 'are you there'));
    await first.kill('SIGKILL');

    cores.push(await startUnitsCore(dirs, llm));
    const second = await startedUnit(dirs);
    units.push(second);
    // The core does not catch up: the backlog is kept as history and starts no turn.
    await until(() => query(dirs, `SELECT 1 FROM sources WHERE kind = 'seen'`).length === 2, 'm2 kept as history');
    await pause(300);
    assert.deepEqual(await second.posted('c1'), [], 'no reply over the backlog');
    assert.equal(llm.requests.length, 1, 'one turn, for m1');
    // The catalog retains native message IDs while sources.native_id stores an opaque family key.
    assert.deepEqual(
      query(
        dirs,
        `SELECT f.message_id AS native_id FROM sources s
        LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
        WHERE s.kind = 'seen' ORDER BY s.rowid`
      ).map((row) => row.native_id),
      ['m1', 'm2']
    );
  });
});

// A second core over the same data.
test('a second core over the same data is refused and the first keeps its socket', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const socket = join(dirs.dataDir, 'run', 'core.sock');
    const before = statSync(socket).ino;
    await assert.rejects(startUnitsCore(dirs, llm), /locked|core-running/);
    assert.equal(existsSync(socket), true, 'the refused start left the first core its socket');
    assert.equal(statSync(socket).ino, before, 'the refused start did not replace the socket file');
    assert.equal(existsSync(lockPathOf(join(dirs.dataDir, 'memory.db'))), true, 'the first core still holds the lock');
  });
});

/** The `core:alive` lease written as another core would have left it, through a writer that is then closed. */
function aliveOfAnotherCore(dirs: Dirs, renewedAt: number, ttlMs: number): void {
  mkdirSync(dirs.dataDir, { recursive: true });
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'));
  try {
    applyWakeQueueWrite(handle, { kind: 'wake-queue', op: 'alive', holder: 'core:other', now: renewedAt, ttlMs });
  } finally {
    handle.close();
  }
}

// Another core that renewed `core:alive` within its ttl.
test('a start refuses with core-running while another holder renewed core:alive within its ttl', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    aliveOfAnotherCore(dirs, T0 - 10_000, 300_000);
    await assert.rejects(
      startUnitsCore(dirs, llm, () => T0).then((core) => {
        cores.push(core);
        return core;
      }),
      /core-running/
    );
    assert.equal(existsSync(lockPathOf(join(dirs.dataDir, 'memory.db'))), false, 'the refused start released the lock');
  });
});

// The boundary: a lease past its ttl is a core that is gone.
test('a start goes ahead when the core:alive lease of another holder expired', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    aliveOfAnotherCore(dirs, T0 - 400_000, 300_000);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    assert.equal(existsSync(join(dirs.dataDir, 'run', 'core.sock')), true);
  });
});

// A restart: the core that stopped cleanly must not refuse its own successor.
test('a core stopped cleanly lets the next start in at once', async () => {
  await withRig(
    {
      features: { wakes: true, intentions: false },
      wakes: { mode: 'shadow', tickSeconds: 1, review: { enabled: false } },
      heartbeat: { enabled: false },
    },
    async ({ dirs, llm, cores }) => {
      const first = await startUnitsCore(dirs, llm, () => T0);
      await until(() => query(dirs, "SELECT 1 FROM leases WHERE name = 'core:alive'").length > 0, 'core:alive');
      await first.stop();
      cores.push(await startUnitsCore(dirs, llm, () => T0 + 1000));
      assert.equal(existsSync(join(dirs.dataDir, 'run', 'core.sock')), true);
    }
  );
});

/** The private layer's settings as the file holds them. */
const localConfig = (dirs: Dirs): Settings =>
  JSON.parse(readFileSync(join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as Settings;

// The drain runs out.
test('disable ends a send the interface holds past drainMs unknown, keeps the choice and refuses the reconnect', async () => {
  await withRig({ interfaces: { drainMs: 300 } }, async ({ dirs, llm, units, cores, logs }) => {
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    const first = await startedUnit(dirs);
    units.push(first);
    await first.ask({ op: 'hold' }, 'done');
    const held = first.told('held');
    assert.equal(await (await first.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await held;

    const outcome = await core.interfaces.disable('fake');
    assert.deepEqual(outcome, { drained: 0, unknown: 1 });
    const local = localConfig(dirs);
    const { interfaces } = local;
    assert.equal(isRecord(interfaces) && isRecord(interfaces.fake) && interfaces.fake.enabled, false);
    assert.deepEqual(
      core.interfaces.list().map((entry) => [entry.name, entry.enabled, entry.connected]),
      [['fake', false, false]]
    );

    await first.kill('SIGKILL');
    const second = spawnUnit(dirs);
    units.push(second);
    await second.told('started').catch(() => {});
    if (second.child.exitCode === null) {
      await second.ask({ op: 'seed-chat', info: channelInfo('c1') }, 'done').catch(() => null);
      await second.emit(mention('m2', 'still there')).catch(() => null);
    }
    await until(() => helloRefused(logs, 'interface-disabled'), 'the refusal of the disabled interface');
    await pause(300);
    assert.deepEqual(
      query(dirs, 'SELECT event_id FROM ingest').map((row) => row.event_id),
      ['fake:message:m1'],
      'nothing the refused unit sent was ingested'
    );
  });
});

// The drain finishes in time.
test('disable lets a send the interface finishes within drainMs complete', async () => {
  await withRig({ interfaces: { drainMs: 5000 } }, async ({ dirs, llm, units, cores }) => {
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    const unit = await startedUnit(dirs);
    units.push(unit);
    await unit.ask({ op: 'hold' }, 'done');
    const held = unit.told('held');
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await held;

    const disabling = core.interfaces.disable('fake');
    await pause(100);
    await unit.ask({ op: 'release' }, 'done');
    assert.deepEqual(await disabling, { drained: 1, unknown: 0 });
    assert.deepEqual(await unit.posted('c1'), [ANSWER], 'the held reply went out');
  });
});

// The choice read at start.
test('a unit of an interface the local layer disables is refused at its first hello', async () => {
  await withRig({ interfaces: { fake: { enabled: false } } }, async ({ dirs, llm, units, cores, logs }) => {
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    const unit = spawnUnit(dirs);
    units.push(unit);
    await unit.told('started').catch(() => {});
    await until(() => helloRefused(logs, 'interface-disabled'), 'the refusal of the disabled interface');
    assert.deepEqual(
      core.interfaces.list().map((entry) => [entry.name, entry.enabled, entry.connected]),
      [['fake', false, false]]
    );
  });
});

test('a unit with the wrong token is refused and nothing it sends is taken', async () => {
  await withRig({}, async ({ dirs, llm, units, cores, logs }) => {
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    // Both processes select one data root; the core's configured token file differs from the unit's invalid token.
    const clientsFile = join(dirs.dataDir, 'clients.json');
    const clients: unknown = JSON.parse(readFileSync(clientsFile, 'utf8'));
    assert.ok(isRecord(clients) && isRecord(clients.fake));
    const acceptedToken = join(dirs.dataDir, 'clients', 'accepted-fake.token');
    writeFileSync(acceptedToken, readFileSync(join(dirs.dataDir, 'clients', 'fake.token')), { mode: 0o600 });
    clients.fake.tokenFile = 'clients/accepted-fake.token';
    writeFileSync(clientsFile, JSON.stringify(clients));
    writeFileSync(join(dirs.dataDir, 'clients', 'fake.token'), `${'0'.repeat(64)}\n`, { mode: 0o600 });
    const unit = spawnUnit(dirs);
    units.push(unit);
    await unit.told('started').catch(() => {});
    await until(() => helloRefused(logs, 'token'), 'the refusal of the wrong token');
    if (unit.child.exitCode === null) {
      await unit.ask({ op: 'seed-chat', info: channelInfo('c1') }, 'done').catch(() => null);
      await unit.emit(mention('m1', 'hello bot')).catch(() => null);
    }
    await pause(300);
    assert.equal(query(dirs, 'SELECT 1 FROM ingest').length, 0, 'no event of the stray unit was ingested');
    assert.equal(llm.requests.length, 0);
    assert.deepEqual(
      core.interfaces.list().map((entry) => [entry.name, entry.connected]),
      [['fake', false]]
    );
  });
});

// With no memoryDb setting the core records its heartbeat as a wake run and runs the day's focus job.
test('a core with no memoryDb setting records its heartbeat as a wake run and runs the focus job of the day', async () => {
  const realStart = Date.now();
  const now = (): number => T0 + (Date.now() - realStart) * 60;
  await withRig(
    {
      features: { wakes: true, intentions: false },
      wakes: {
        mode: 'shadow',
        tickSeconds: 1,
        review: { enabled: false },
      },
      heartbeat: { enabled: true, schedule: 'every 1m', jitterMinutes: 0 },
    },
    async ({ dirs, llm, cores }) => {
      cores.push(await startUnitsCore(dirs, llm, now));
      await until(
        () => query(dirs, "SELECT 1 FROM wake_runs WHERE kind = 'heartbeat'").length > 0,
        'a heartbeat wake run',
        10000
      );
      await until(
        () => query(dirs, "SELECT 1 FROM meta WHERE key = 'focus_last_day'").length > 0,
        'the focus job of the day',
        10000
      );
      const runs = query(dirs, "SELECT status FROM wake_runs WHERE kind = 'heartbeat'");
      assert.ok(runs.length >= 1, 'the heartbeat is a wake run');
    }
  );
});

// No catch-up through the real core: nothing is read or answered on its own after an
// absence. The model is a function that records its requests, so nothing calls a provider.

test('a restart reads no missed history and starts no turn over it, and the next message is answered', async () => {
  // Bug: the start catches up on what was said during the downtime, or answers a question hours old.
  await noReplayWithRig({}, async ({ dirs, llm, units, cores }) => {
    const first = await noReplayStartUnitsCore(dirs, llm);
    cores.push(first);
    const before = await noReplayStartedUnit(dirs);
    units.push(before);
    assert.equal(await (await before.emit(noReplayMention('m1', 'hello bot'))).acked, 'ok');
    await noReplayPostedOnce(before, 1);
    await first.stop();
    await before.kill();

    cores.push(await noReplayStartUnitsCore(dirs, llm));
    const after = await noReplayStartedUnit(dirs);
    units.push(after);
    await settle(600);
    assert.equal(llm.requests.length, 1, 'no turn at the start');
    assert.equal(await (await after.emit(noReplayMention('m2', 'are you back'))).acked, 'ok');
    await noReplayPostedOnce(after, 1);
    assert.equal(llm.requests.length, 2);
  });
});

// --- the slice end to end ------------------------------------------------------------------------------------------

// The fake interface (scripts/lib/fake-interface.ts) holds the chat and answers the core's reads. One member message
// that names the persona goes through the link, the event door, the pipeline, a turn and the memory database, and the
// persona's `<msg>` text comes back over the link to the fake adapter. The settings that would add helper requests or
// random behaviour are switched off in the private layer. The link socket sits at `<data>/run/core.sock`.
type Running = Awaited<ReturnType<typeof start>>;
type MemberMessage = { id: string; content: string; at: number };
const SELF_ID = 'self-id';
const SLICE_ANSWER = 'γεια σου, καλημέρα';
const SLICE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: false,
    offlineCatchUp: false,
    diary: false,
    mediaDescriptions: false,
    missedAnswers: false,
    channelRoute: false,
    recall: false,
    memoryPrefetch: false,
    channelPull: false,
    elsewhere: false,
    speech: false,
    pauseNotice: false,
  },
};

async function sliceUntil(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Short folders: a Unix socket path is limited to 108 bytes.
function sliceFolders(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  // The runtime private alias and all prepared persona files use the selected data root.
  const privateDir = dataDir;
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify({ ...SLICE_CONFIG, ...extra }));
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

// The scripted model: it answers every request with `<msg>` + ANSWER and keeps the requests it got.
function sliceLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    // The door asks the address classifier first, which says yes and is not recorded.
    complete: (messages: unknown, given?: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${SLICE_ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

async function withCore(
  body: (core: Awaited<ReturnType<typeof startCore>>, ctx: SliceContext) => Promise<void>,
  extra: Record<string, unknown> = {}
) {
  const dirs = sliceFolders(extra);
  const llm = sliceLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { selfId: SELF_ID });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  const dbPath = join(dirs.dataDir, 'memory.db');
  live.adapter.seedChat(channelInfo('c1'));
  const ctx: SliceContext = {
    ...dirs,
    dbPath,
    llm,
    mentionEvent: (message) =>
      deliver(live.adapter, { id: message.id, text: message.content, at: message.at, mention: true }),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
    rows: (kind) => {
      const handle = openMemoryDb(dbPath, { readOnly: true });
      try {
        // Catalog IDs preserve the protocol identity while source native_id values identify opaque families.
        const sql = `SELECT s.kind, f.message_id AS native_id, s.text, s.direct FROM sources s
          LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
          WHERE s.kind = ? ORDER BY s.rowid`;
        return (handle.db as { prepare(sql: string): { all(kind: string): Array<Row> } })
          .prepare(sql)
          .all(kind)
          .map((row) => ({ ...row }));
      } finally {
        handle.close();
      }
    },
  };
  let stopped = false;
  ctx.stop = async () => {
    stopped = true;
    await core.stop();
  };
  try {
    await body(core, ctx);
  } finally {
    if (!stopped) await core.stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

type SliceContext = ReturnType<typeof sliceFolders> & {
  dbPath: string;
  llm: ReturnType<typeof sliceLlm>;
  mentionEvent(message: MemberMessage): unknown;
  emit(event: unknown): Promise<string>;
  posted(): Array<string>;
  rows(kind: string): Array<Row>;
  stop?: () => Promise<void>;
};

test("one message that names the persona makes one observe row, one model request, the persona's text at the fake and a said row", async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const status = await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello bot', at: Date.now() }));
      assert.equal(status, 'ok');
      await sliceUntil(() => ctx.posted().length === 1 && ctx.rows('said').length === 1);
      const { requests } = ctx.llm;
      assert.equal(requests.length, 1, 'one model request');
      assert.deepEqual(ctx.posted(), [SLICE_ANSWER], "the persona's text arrived unchanged");
      const seen = ctx.rows('seen').map((row) => [row.native_id, row.text]);
      assert.deepEqual(seen, [['m1', 'hello bot']], 'one observe row for the message');
      assert.deepEqual(
        ctx.rows('said').map((row) => row.text),
        [SLICE_ANSWER]
      );
    })
  );
});

test('stop closes the memory database, releases its lock and removes the socket file', async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const socket = join(ctx.dataDir, 'run', 'core.sock');
      assert.equal(existsSync(socket), true, 'the core listens while it runs');
      assert.equal(existsSync(lockPathOf(ctx.dbPath)), true, 'the core holds the writer lock while it runs');
      await ctx.stop?.();
      assert.equal(existsSync(socket), false);
      assert.equal(existsSync(lockPathOf(ctx.dbPath)), false);
      // A writer opens at once: nothing of the core still holds the file.
      openMemoryDb(ctx.dbPath).close();
    })
  );
});

test('an absent canonical data directory is created and the fresh core shuts down cleanly', async () => {
  const dirs = sliceFolders();
  const dataDir = join(dirs.root, 'missing');
  const rootDir = join(dirs.root, 'engine');
  mkdirSync(rootDir);
  for (const folder of ['config', 'prompts', 'agents'])
    cpSync(join(REPO, folder), join(rootDir, folder), { recursive: true });
  writeFileSync(join(rootDir, 'config', 'config.json'), JSON.stringify(SLICE_CONFIG));
  assert.equal(existsSync(dataDir), false);
  try {
    await withCapturedLogs(async () => {
      // Fresh persona storage bootstraps without a pre-existing private layer.
      const core = await startCore({
        paths: { rootDir, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [],
        llm: sliceLlm(),
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        assert.equal(existsSync(dataDir), true);
      } finally {
        await core.stop();
      }
      assert.equal(existsSync(join(dataDir, 'run', 'core.sock')), false);
      assert.equal(existsSync(lockPathOf(join(dataDir, 'memory.db'))), false);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a core whose video role is off starts no yt-dlp probe of the YouTube canary', async () => {
  // `media.video.ytdlpPath` names a script that leaves a marker when it runs. The canary probe runs it at the start
  // when the video role is up, so an absent marker after the start shows the probe never began.
  const scratch = mkdtempSync(join(tmpdir(), 'cy-'));
  const marker = join(scratch, 'ran');
  const script = join(scratch, 'yt-dlp.sh');
  writeFileSync(script, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  try {
    await withCapturedLogs(() =>
      withCore(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          assert.equal(existsSync(marker), false);
        },
        { models: { routes: chainsOf({ video: false }) }, media: { video: { ytdlpPath: script } } }
      )
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- who the persona is and which interface a row belongs to ------------------------------------------------------

// The fake interface's `hello` names the persona and the root. The persona's name in every request is the one of
// `hello`, a nickname change that arrives as `membership.changed` changes it for the next request, and the rows of the
// persona's turn carry the interface of the event, not a fixed one.
const SELF_NAME = 'Nova';

async function identityUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Short folders: a Unix socket path is limited to 108 bytes.
function identityFolders() {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  // Runtime privateDir aliases the prepared persona data root.
  const privateDir = dataDir;
  mkdirSync(join(privateDir, 'config'), { recursive: true });
  writeFileSync(join(privateDir, 'config', 'config.json'), JSON.stringify(SLICE_CONFIG));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

async function withIdentityCore(body: (ctx: IdentityContext) => Promise<void>) {
  const dirs = identityFolders();
  const llm = sliceLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, {
            self: { id: SELF_ID, name: SELF_NAME },
            root: { id: 'g1', name: 'Alpha' },
          });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  const dbPath = join(dirs.dataDir, 'memory.db');
  live.adapter.seedChat(channelInfo('c1'));
  const ctx: IdentityContext = {
    ...dirs,
    dbPath,
    llm,
    mentionEvent: (message) =>
      deliver(live.adapter, { id: message.id, text: message.content, at: message.at, mention: true }),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
    rows: (kind) => {
      const handle = openMemoryDb(dbPath, { readOnly: true });
      try {
        const sql = 'SELECT id, iface, kind, native_id FROM sources WHERE kind = ? ORDER BY rowid';
        return (handle.db as { prepare(sql: string): { all(kind: string): Array<Row> } })
          .prepare(sql)
          .all(kind)
          .map((row) => ({ ...row }));
      } finally {
        handle.close();
      }
    },
  };
  try {
    await body(ctx);
  } finally {
    await core.stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

type IdentityContext = ReturnType<typeof identityFolders> & {
  dbPath: string;
  llm: ReturnType<typeof sliceLlm>;
  mentionEvent(message: MemberMessage): unknown;
  emit(event: unknown): Promise<string>;
  posted(): Array<string>;
  rows(kind: string): Array<Row>;
};

const requestText = (ctx: IdentityContext, index: number): string => {
  const { requests } = ctx.llm;
  return JSON.stringify(requests[index]);
};

function nicknameChange(accountId: string, name: string, n: number): Row {
  return {
    kind: 'membership.changed',
    iface: 'fake',
    at: Date.now(),
    id: `fake:membership:g1:${accountId}:updated:${n}`,
    placeId: 'g1',
    accountId,
    change: 'updated',
    member: { id: accountId, name, bot: accountId === SELF_ID },
  };
}

test('a nickname change of the persona reaches the next request', async () => {
  await withCapturedLogs(() =>
    withIdentityCore(async (ctx) => {
      await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello', at: Date.now() }));
      await identityUntil(() => ctx.posted().length === 1);
      assert.equal(await ctx.emit(nicknameChange(SELF_ID, 'Nova2', 1)), 'ok');
      await ctx.emit(ctx.mentionEvent({ id: 'm2', content: 'and now', at: Date.now() }));
      await identityUntil(() => ctx.posted().length === 2);
      assert.ok(requestText(ctx, 1).includes('You are Nova2, '), 'the new nickname');
      assert.equal(requestText(ctx, 1).includes(`You are ${SELF_NAME}, `), false, 'not the old one');
    })
  );
});

test("the rows of the persona's turn carry the interface of the event, not a fixed one", async () => {
  await withCapturedLogs(() =>
    withIdentityCore(async (ctx) => {
      await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello', at: Date.now() }));
      // The answer row is written at the turn's end, after the said row: wait for both before reading them.
      await identityUntil(
        () => ctx.posted().length === 1 && ctx.rows('said').length === 1 && ctx.rows('answer').length === 1
      );
      const [said] = ctx.rows('said');
      assert.equal(said?.iface, 'fake');
      // The persona's line adopts the observed row of its message family, whose id is the family's, so the interface is the fact here.
      assert.equal(ctx.rows('said').length, 1);
      assert.deepEqual(
        ctx.rows('answer').map((row) => row.iface),
        ['fake']
      );
    })
  );
});

// --- the names of an interface's hello -----------------------------------------------------------------------------

// The names an interface declares in its hello (`hello.names`: its name, its noun per kind of place, its word for a
// direct chat) reach the memory whether or not the hello names a root. The fake interface starts in the core's process,
// the way the command line does. Made-up names.
const HELLO_NAMES = { interface: 'Solo Net', nouns: { channel: 'room' }, dm: 'private line' };

/** Starts a core whose one in-process interface says hello with `HELLO_NAMES` and no root, then reads what the memory holds. */
async function namesAfterHello(): Promise<ReturnType<typeof interfaceNamesOf>> {
  const root = mkdtempSync(join(tmpdir(), 'hn-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({ bot: { timezone: 'UTC', owners: [] }, models: { routes: chainsOf({ video: false }) } })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  // The id the fake's hello carries, which is the id the memory stores the names under.
  let iface = '';
  try {
    const { result } = await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [
          {
            name: 'solo',
            start: async (host) => {
              const running = await start(host, { selfId: 'self-id', root: null, names: HELLO_NAMES });
              iface = running.adapter.iface;
              return running;
            },
          },
        ],
        llm: { complete: () => Promise.resolve({ text: '<msg>x</msg>', usage: {}, estimated: 1 }) },
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        // The write goes through the one writer asynchronously: read until the name shows or the time is up.
        const deadline = Date.now() + 5000;
        for (;;) {
          const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
          try {
            const found = interfaceNamesOf(handle.db as Parameters<typeof interfaceNamesOf>[0], iface);
            if (found.name !== null || Date.now() > deadline) return found;
          } finally {
            handle.close();
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await core.stop();
      }
    });
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a hello that carries names and no root stores the interface name, its nouns and its word for a direct chat', async () => {
  // Bug: the primary hello was written with its roots only and without its names, so an interface that serves no root
  // (the command line) kept `name` and `extra` empty and its chat read with the bare kind and the interface id.
  const found = await namesAfterHello();
  assert.deepEqual(found, { name: 'Solo Net', nouns: { channel: 'room' }, dm: 'private line' });
});

// --- two interfaces at once ---------------------------------------------------------------------------------------

// Two interfaces connected to one core at once, as units: the same native chat, member and root ids on both, and
// several roots on one.
const TWO_ANSWER = 'γεια σου';
const TWO_SELF = { id: 'self-id', name: 'Nova' };

async function withTwoInterfaces(
  body: (rig: { fake: Running; other: Running; requests: Array<unknown>; dataDir: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ti-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: ['u1'], placeId: 'g1' },
      dm: { enabled: true },
      private: { minAffinity: 0 },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 2000 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  for (const name of ['fake', 'other']) {
    addClient(dataDir, name, { kind: 'interface', iface: name, permissions: [] });
  }
  const requests: Array<unknown> = [];
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dataDir, dataDir },
    env: {},
    interfaces: [],
    llm: {
      complete: (messages: unknown) => {
        requests.push(messages);
        return Promise.resolve({ text: `<msg>${TWO_ANSWER}</msg>`, usage: {}, estimated: 10 });
      },
    },
    embedder: { embed: () => Promise.resolve([]) },
  });
  const started: Array<Running> = [];
  const connect = async (name: string, roots: ReadonlyArray<{ id: string; name: string }>) => {
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const running = await start(
      {
        connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
        token: readFileSync(join(dataDir, 'clients', `${name}.token`), 'utf8').trim(),
        dataDir: join(dataDir, 'interfaces', name),
        env: {},
        config: () => ({}),
        onConfigChange: () => () => {},
        log,
      },
      { adapter: createFakeAdapter({ iface: name, selfId: TWO_SELF.id }), self: TWO_SELF, roots }
    );
    started.push(running);
    return running;
  };
  try {
    const fake = await connect('fake', [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ]);
    const other = await connect('other', [{ id: 'g3', name: 'Gamma' }]);
    await body({ fake, other, requests, dataDir });
  } finally {
    for (const running of started) await running.stop();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('each message is answered on its own interface and root when their native ids collide', async () => {
  // Bug: every effect goes to the first interface that connected, or a second interface's events are dropped.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ fake, other, dataDir }) => {
      fake.adapter.seedChat(channelInfo('c1'));
      fake.adapter.seedChat({ ...channelInfo('c2'), rootId: 'g2' });
      other.adapter.seedChat({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      const postedIn = (running: Running, chat: string) =>
        running.adapter.messagesIn(chat).filter((message) => message.authorId === TWO_SELF.id);

      const onOther = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...onOther, iface: 'other', chat: { ...onOther.chat, rootId: 'g3' } });
      await fakeUntil(() => postedIn(other, 'c1').length > 0);
      assert.equal(postedIn(fake, 'c1').length, 0);

      const inSecond = deliver(fake.adapter, {
        chatId: 'c2',
        id: 'm1',
        text: 'Nova, hello',
        at: Date.now(),
        mention: true,
      });
      await fake.emit({ ...inSecond, chat: { ...inSecond.chat, rootId: 'g2' } });
      await fakeUntil(() => postedIn(fake, 'c2').length > 0);
      assert.deepEqual(
        postedIn(fake, 'c2').map((message) => message.text),
        [TWO_ANSWER]
      );
      assert.equal(postedIn(other, 'c2').length, 0);

      // The two messages share native ids, and each is kept under its own interface.
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const rows = (handle.db as { prepare(sql: string): { all(): Array<{ iface: string }> } })
          .prepare(`SELECT DISTINCT iface FROM sources WHERE kind = 'seen' ORDER BY iface`)
          .all();
        assert.deepEqual(
          rows.map((row) => row.iface),
          ['fake', 'other']
        );
      } finally {
        handle.close();
      }
    });
  });
});

const cutoverIsRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type Runner = { runs: Array<Record<string, unknown>>; close: () => Promise<void> };

/** A scout runner on `path`: it answers a ping, and ends every run it gets as done with `usd` spent. */
async function fakeScout(path: string, usd = 0.2): Promise<Runner> {
  const runs: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line: unknown = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!cutoverIsRecord(line)) continue;
        if (line.op === 'ping') socket.write(encodeLine(pongEvent({ unit: 'scout', busy: false, queued: 0 })));
        if (line.op === 'run' && typeof line.id === 'string') {
          runs.push(line);
          const result = { text: 'nine to five', sources: [], files: [] };
          const usage = { input: 1000, output: 200, usd, steps: 2, seconds: 3 };
          socket.write(encodeLine(endEvent({ id: line.id, status: 'done', result, usage })));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { runs, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** One errand the persona hands off: the member's line that asks for it, and the goal the persona gives the scout. */
type Asked = { line: string; goal: string };
const OPENING: Asked = { line: 'Ask the scout when the library opens.', goal: 'find the opening hours of the library' };

/**
 * The model of the persona's turns: the first request that holds the line of an errand calls `errand.scout` for the scout with its
 * goal, and every other request is answered with one message. Their result turn shows the asking line again, so it gets
 * the message.
 */
function errandModel(asked: ReadonlyArray<Asked>): CutoverLlm {
  const requests: Array<unknown> = [];
  const used = new Set<string>();
  // The rig's Llm records the options of each call since PR 7a; this model keeps none.
  return {
    requests,
    options: [],
    // Plan 2026-11-04-cli-and-memory B1: the door asks the address classifier first; it says yes and is not scripted.
    complete: (messages: unknown, given?: unknown) => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      const text = JSON.stringify(messages);
      const due = asked.find((item) => !used.has(item.line) && text.includes(item.line));
      if (due === undefined) return Promise.resolve({ text: `<msg>${CUTOVER_ANSWER}</msg>`, usage: {}, estimated: 10 });
      used.add(due.line);
      const answer = toolAnswer('<think>a scout errand</think>', [call('errand.scout', { goal: due.goal })]);
      // toolAnswer gives the completion the native transport resolves, its text and usage included.
      return Promise.resolve(answer as { text: string; usage: object; estimated: number });
    },
  };
}

/** The private layer of an errand rig: the scout on, the persona `errand.scout` granted. */
function errandConfig(): CutoverSettings {
  return {
    bot: { access: { 'errand.scout': { everyone: false, roles: [], users: [SELF_ID] } } },
    // The scout's end can reach the core while the persona's opening turn still holds the attention, and the result turn is
    // held and tried again every `resultRetrySeconds`, twenty times. At 0 the twenty tries run out within milliseconds
    // when the opening turn's reply waits on a slow interface process, and no result turn runs at all. One second
    // gives the opening turn twenty seconds.
    errands: { maxOpen: 3, resultCooldownSeconds: 0, resultRetrySeconds: 1 },
    agents: { scout: { enabled: true, daily: { tasks: 5 } } },
  };
}

test("the persona's errand's recent lines name the persona on their own line", async () => {
  // Bug: the core named the persona's lines in an errand's `context.recent` by `bot.name`, which is no setting, so the agent got
  // each of them with an empty author. The fake interface's `hello` names the persona `Nova`.
  const sockets = tempDir('nb-');
  fs.mkdirSync(join(sockets, 'neptunia-agent-scout'));
  const scout = await fakeScout(join(sockets, 'neptunia-agent-scout', 'sock'));
  const env = { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: sockets, XDG_STATE_HOME: join(sockets, 'state') };
  try {
    await noReplayWithRig({ config: errandConfig() }, async ({ dirs, cores, units }) => {
      cores.push(await noReplayStartUnitsCore(dirs, errandModel([OPENING]), undefined, env));
      const unit = await noReplayStartedUnit(dirs);
      units.push(unit);
      await (
        await unit.emit(noReplayMention('m1', 'the tower zeta71 has seven floors'))
      ).acked;
      await noReplayPostedOnce(unit, 1);
      await (
        await unit.emit(noReplayMention('m2', OPENING.line))
      ).acked;
      await cutoverUntil(() => scout.runs.length > 0, 'the errand to reach the scout');
      const [run] = scout.runs;
      const { recent = [] } = (run?.context ?? {}) as { recent?: Array<{ author: string; text: string }> };
      const own = recent.filter((line) => line.text === CUTOVER_ANSWER);
      assert.deepEqual(own, [{ author: 'Nova', text: CUTOVER_ANSWER }], JSON.stringify(recent));
    });
  } finally {
    await scout.close();
  }
});

/** The native ids of the lines the live path stored. */
const lines = (dirs: LockDirs): Array<string> => seenIds(dirs).filter((id): id is string => typeof id === 'string');
const countOf = (dirs: LockDirs, sql: string): number => Number(lockQuery(dirs, sql)[0]?.n ?? 0);

/** One install: its rig and the database file in its data folder, created at the current schema. */
type World = { rig: Rig; db: string };

const maintained = (body: (w: World) => void | Promise<void>): Promise<void> =>
  noReplayWithRig({ clients: [FAKE_CLIENT] }, async (rig) => {
    const db = path.join(rig.dirs.dataDir, 'memory.db');
    openMemoryDb(db).close();
    await body({ rig, db });
  });

test('a message that arrives while maintenance holds the writer is handled once when the database opens', () =>
  maintained(async (w) => {
    // Bug: the line is lost, answered twice, or stored twice when the interface recovers it after the restart.
    const { dirs, llm, units, cores } = w.rig;
    const core = await noReplayStartUnitsCore(dirs, llm);
    cores.push(core);
    const first = await noReplayStartedUnit(dirs);
    units.push(first);
    assert.equal(await (await first.emit(noReplayMention('m1', 'before maintenance'))).acked, 'ok');
    await cutoverUntil(() => llm.requests.length === 1, 'the turn of m1');
    await core.stop();
    cores.pop();

    const release = acquireLock(w.db);
    // The core is down, so the line waits in the unit's outbox; the unit then dies before any core takes it.
    const waiting = lineEvent({ id: 'm2', text: 'said during maintenance', at: Date.now() });
    await first.emit(waiting);
    await first.kill('SIGKILL');
    await assert.rejects(noReplayStartUnitsCore(dirs, llm), /locked/);
    assert.deepEqual(lines(dirs), ['m1'], 'nothing was written while the writer was held');
    release();

    cores.push(await noReplayStartUnitsCore(dirs, llm));
    const second = await noReplayStartedUnit(dirs);
    units.push(second);
    await cutoverUntil(() => lines(dirs).includes('m2'), 'm2 kept after the database opened');
    // The interface recovers the same line from the platform's history under an event id of its own.
    const recovered = await second.emit({ ...waiting, id: 'fake:recovered:m2' });
    assert.ok(['ok', 'duplicate'].includes(await recovered.acked), 'the core answered the recovered event');
    await settle(600);
    assert.deepEqual(lines(dirs), ['m1', 'm2'], 'one stored line for m2');
    assert.equal(llm.requests.length, 1, 'the line of the maintenance hours starts no turn of its own');
    assert.equal(countOf(dirs, "SELECT count(*) AS n FROM ingest WHERE event_id = 'fake:message:m2'"), 1);
    // Handling has resumed: the next call is answered.
    assert.equal(await (await second.emit(noReplayMention('m3', 'back again'))).acked, 'ok');
    await cutoverUntil(() => llm.requests.length === 2, 'the turn of m3');
  }));

const SECOND_REPO = fileURLToPath(new URL('../..', import.meta.url));
const RUNNER = join(SECOND_REPO, 'tests', 'fixtures', 'instance-runner.ts');
const NAMES = ['alpha', 'beta'] as const;
type Name = (typeof NAMES)[number];

type Instance = {
  name: Name;
  /** The instance's folder: its engine copy, private layer and data folder sit under it. */
  dir: string;
  engine: string;
  privateDir: string;
  dataDir: string;
  /** What its prompt layer says and what its scripted model answers: nothing the other instance holds. */
  persona: string;
  answer: string;
  child: ChildProcess;
};

type Stat = { size: number; mtimeMs: number };
type Tree = Map<string, Stat>;

const settings = (placeId: string) => ({
  bot: { timezone: 'UTC', owners: [], placeId },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
});

/** Every file under `dir` (sockets included) as a path relative to it, with its size and modification time. */
function walk(dir: string): Tree {
  const tree: Tree = new Map();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const stat = lstatSync(full);
      if (entry.isDirectory()) visit(full);
      else tree.set(full.slice(dir.length + 1), { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  visit(dir);
  return tree;
}

/** The paths in `after` that `before` did not hold, and the ones whose size or time changed. */
function changes(before: Tree, after: Tree): Array<string> {
  const out: Array<string> = [];
  for (const [path, stat] of after) {
    const old = before.get(path);
    if (old === undefined || old.size !== stat.size || old.mtimeMs !== stat.mtimeMs) out.push(path);
  }
  return out.sort();
}

const isWithin = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + sep);

/** The tracked tree of the checkout, file by file, into `to`: the public engine as a clean clone holds it. */
function copyTrackedTree(to: string): void {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: SECOND_REPO, maxBuffer: 64 * 1024 * 1024 }).toString(
    'utf8'
  );
  for (const file of listed.split('\0').filter((name) => name !== '')) {
    const from = join(SECOND_REPO, file);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(to, file)), { recursive: true });
    cpSync(from, join(to, file));
  }
}

function layout(root: string, name: Name): Omit<Instance, 'child'> {
  const dir = join(root, name);
  const persona = `Persona marker ${name} ${name.length * 7919}`;
  return {
    name,
    dir,
    engine: join(dir, 'engine'),
    privateDir: join(dir, 'data'),
    dataDir: join(dir, 'data'),
    persona,
    answer: `answer of ${name}`,
  };
}

function writeLayer(one: Omit<Instance, 'child'>): void {
  mkdirSync(join(one.privateDir, 'config'), { recursive: true });
  mkdirSync(join(one.privateDir, 'prompts'), { recursive: true });
  writeFileSync(join(one.privateDir, 'config', 'config.json'), JSON.stringify(settings(`g-${one.name}`)));
  writeFileSync(join(one.privateDir, 'prompts', 'persona.md'), `${one.persona}. You are a quiet guest.\n`);
}

type Pending = Map<number, (reply: InstanceReply) => void>;

/** One request to the runner of `one`, answered with its value. */
function ask(pending: Pending, one: Instance, request: InstanceCommand): Promise<unknown> {
  const id = pending.size + 1 + Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    pending.set(id, (reply) => (reply.ok ? resolve(reply.value) : reject(new Error(reply.error))));
    one.child.send({ ...request, id });
  });
}

function startChild(one: Omit<Instance, 'child'>, pending: Pending): Promise<Instance> {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [one.engine], {
      cwd: one.dir,
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: tmpdir(),
        NEPTUNIA_DATA_DIR: one.dataDir,
        INSTANCE_ANSWER: one.answer,
      },
      // The test runner's own flags (inspector port, coverage) are not the child's.
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) =>
      reject(new Error(`the ${one.name} runner exited (${String(code)}) before it was ready: ${stderr}`))
    );
    child.on('message', (message: InstanceReady | InstanceReply) => {
      if ('ready' in message) {
        child.removeAllListeners('exit');
        resolve({ ...one, child });
        return;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
  });
}

async function secondUntil(check: () => Promise<boolean>, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The open files and the named sockets of a process, read from /proc (Linux). */
function openPaths(pid: number): { files: Array<string>; sockets: Array<string> } {
  const files: Array<string> = [];
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const socket = /^socket:\[(\d+)\]$/.exec(target);
    if (socket?.[1] !== undefined) inodes.add(socket[1]);
    else if (target.startsWith('/')) files.push(target);
  }
  const sockets: Array<string> = [];
  for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    const inode = columns[6];
    const path = columns[7];
    if (inode !== undefined && path !== undefined && inodes.has(inode)) sockets.push(path);
  }
  return { files, sockets };
}

/** The `sources` rows of kind `seen` and `said` of an instance's database, read through a read-only connection. */
function sourceTexts(one: Instance): Array<string> {
  const handle = openMemoryDb(join(one.dataDir, 'memory.db'), { readOnly: true });
  try {
    const db = handle.db as { prepare(sql: string): { all(): Array<Record<string, unknown>> } };
    return db
      .prepare('SELECT text FROM sources ORDER BY rowid')
      .all()
      .map((row) => String(row.text));
  } finally {
    handle.close();
  }
}

const world: {
  root: string;
  alpha: Instance;
  beta: Instance;
  engineBefore: Record<Name, Tree>;
  layerBefore: Record<Name, Tree>;
  rootBefore: Tree;
  rootAfter: Tree;
  requests: Record<Name, Array<string>>;
  posted: Record<Name, Array<string>>;
  open: Record<Name, ReturnType<typeof openPaths>>;
  stop(): Promise<void>;
} = {} as never; // filled in `before`, read by every test below: the two children run once for all of them

// Only configuration and prompt inputs stay immutable; runtime records share their canonical data root.
const personalFiles = (dir: string): Tree =>
  new Map(
    [...walk(dir)].filter(([at]) => ['config', 'prompts'].some((part) => at === part || at.startsWith(`${part}/`)))
  );

const textOf = (name: Name): string => `question to ${name}`;

describe('two instances side by side', () => {
  before(async () => {
    const root = mkdtempSync(join(tmpdir(), 'si-'));
    world.root = root;
    const plain = { alpha: layout(root, 'alpha'), beta: layout(root, 'beta') };
    for (const one of Object.values(plain)) {
      copyTrackedTree(one.engine);
      writeLayer(one);
    }
    world.engineBefore = { alpha: walk(plain.alpha.engine), beta: walk(plain.beta.engine) };
    world.layerBefore = { alpha: personalFiles(plain.alpha.privateDir), beta: personalFiles(plain.beta.privateDir) };
    world.rootBefore = walk(root);
    const pending: Pending = new Map();
    const [alpha, beta] = await Promise.all([startChild(plain.alpha, pending), startChild(plain.beta, pending)]);
    world.alpha = alpha;
    world.beta = beta;
    const both = [alpha, beta];
    // The same chat and message id in both instances; only the text differs.
    for (const one of both) {
      const event = lineEvent({ id: 'm1', text: textOf(one.name), at: Date.now(), mention: true });
      await ask(pending, one, { kind: 'seed', info: channelInfo('c1'), event });
    }
    await Promise.all(
      both.map(async (one) => {
        const event = lineEvent({ id: 'm1', text: textOf(one.name), at: Date.now(), mention: true });
        const status = await ask(pending, one, { kind: 'emit', event });
        assert.equal(status, 'ok');
      })
    );
    const postedOf = async (one: Instance): Promise<Array<string>> =>
      (await ask(pending, one, { kind: 'posted', chatId: 'c1' })) as Array<string>;
    await secondUntil(async () => (await postedOf(alpha)).length === 1 && (await postedOf(beta)).length === 1);
    await secondUntil(() => Promise.resolve(sourceTexts(alpha).length >= 2 && sourceTexts(beta).length >= 2));
    world.posted = { alpha: await postedOf(alpha), beta: await postedOf(beta) };
    world.requests = {
      alpha: (await ask(pending, alpha, { kind: 'requests' })) as Array<string>,
      beta: (await ask(pending, beta, { kind: 'requests' })) as Array<string>,
    };
    world.open = { alpha: openPaths(alpha.child.pid ?? 0), beta: openPaths(beta.child.pid ?? 0) };
    world.rootAfter = walk(root);
    world.stop = async () => {
      // The listeners go on before the request: a process that has nothing left ends right after its answer.
      const ended = both.map(
        (one) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`the ${one.name} process did not end after stop`)), 10000);
            one.child.once('exit', () => {
              clearTimeout(timer);
              resolve(null);
            });
          })
      );
      for (const one of both) await ask(pending, one, { kind: 'stop' });
      await Promise.all(ended);
    };
  });

  after(() => {
    for (const name of NAMES) {
      const instance = world[name];
      instance?.child.kill('SIGKILL');
    }
    if (world.root) rmSync(world.root, { recursive: true, force: true });
  });

  test('each instance answers the message it was given with its own scripted answer, once', () => {
    assert.deepEqual(world.posted.alpha, ['answer of alpha']);
    assert.deepEqual(world.posted.beta, ['answer of beta']);
  });

  test('the engine copies are the same files after the run as before it', () => {
    for (const name of NAMES) {
      assert.deepEqual(changes(world.engineBefore[name], walk(world[name].engine)), [], `${name} engine copy changed`);
    }
  });

  test('the private layers are the same files after the run as before it', () => {
    for (const name of NAMES) {
      assert.deepEqual(
        changes(world.layerBefore[name], personalFiles(world[name].privateDir)),
        [],
        `${name} layer changed`
      );
    }
  });

  test('the sockets a child holds are its own, and neither child has a file open in the other instance or in the checkout', () => {
    for (const name of NAMES) {
      const other = world[name === 'alpha' ? 'beta' : 'alpha'];
      const { files, sockets } = world.open[name];
      assert.ok(sockets.includes(join(world[name].dataDir, 'run', 'core.sock')), `${name} has its socket open`);
      for (const socket of sockets) assert.ok(isWithin(socket, world[name].dataDir), `${name} holds ${socket}`);
      // A file inside this instance's own folder is its own even when TMPDIR puts that folder under the checkout.
      for (const file of files.filter((file) => !isWithin(file, world[name].dir))) {
        assert.equal(isWithin(file, other.dir), false, `${name} has ${file} open`);
        assert.equal(isWithin(file, SECOND_REPO.replace(/\/$/, '')), false, `${name} has ${file} open`);
      }
    }
  });

  test('each memory database holds the rows of its own message and none of the other', () => {
    for (const name of NAMES) {
      const texts = sourceTexts(world[name]);
      assert.ok(texts.includes(textOf(name)), `${name} kept the message it saw`);
      assert.ok(texts.includes(`answer of ${name}`), `${name} kept its own answer`);
      const other = name === 'alpha' ? 'beta' : 'alpha';
      assert.deepEqual(
        texts.filter((text) => text.includes(other)),
        []
      );
    }
  });

  test('no file of one data folder holds a word of the other instance', () => {
    for (const name of NAMES) {
      const other = name === 'alpha' ? 'beta' : 'alpha';
      for (const path of walk(world[name].dataDir).keys()) {
        const full = join(world[name].dataDir, path);
        if (lstatSync(full).isDirectory() || lstatSync(full).isSocket()) continue;
        const bytes = readFileSync(full);
        assert.equal(bytes.includes(`answer of ${other}`), false, `${full} holds the answer of ${other}`);
        assert.equal(bytes.includes(textOf(other)), false, `${full} holds the question to ${other}`);
      }
    }
  });

  test("each model request carries its own prompt layer and not the other's", () => {
    for (const name of NAMES) {
      const other = name === 'alpha' ? 'beta' : 'alpha';
      const request = world.requests[name];
      assert.equal(request.length, 1, 'one model request');
      const text = request[0] ?? '';
      assert.ok(text.includes(world[name].persona), `${name} request names its persona`);
      assert.equal(text.includes(world[other].persona), false, `${name} request names the persona of ${other}`);
      assert.ok(text.includes(textOf(name)));
    }
  });

  test('a stopped instance ends its process and leaves no socket and no writer lock', async () => {
    await world.stop();
    for (const name of NAMES) {
      assert.equal(existsSync(join(world[name].dataDir, 'run', 'core.sock')), false, `${name} removed its socket`);
      assert.equal(existsSync(lockPathOf(join(world[name].dataDir, 'memory.db'))), false, `${name} released its lock`);
    }
  });
});
