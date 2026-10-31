// The core as its own process and the interfaces as units (stage 4, PR C). `startCore` (src/core.js) runs in the test
// process with no interface, over temporary data and private folders, a scripted model and the tracked prompts. An
// interface runs the way a unit runs it: `bin/neptunia.ts interface run fake --interfaces-dir tests/fixtures/interfaces`
// in a child process, which reads its token from `<private>/clients/fake.token`, connects to `<data>/run/core.sock`
// and serves the fake interface of tests/fixtures/interfaces/fake/index.ts. The test drives that child over its IPC
// channel. The token is written by tools/client-token.mjs, as an operator writes it. No Discord object and no provider
// is reached. The memory database is read through a second, read-only connection, because the core holds the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.js';
import { start as startFake } from '../src/interface/fake-interface.ts';
import { onLog } from '../src/log.js';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.js';
import { applyWakeQueueWrite } from '../src/memory/db/wake-queue.ts';
import { ANSWER, COMMUNITY, SELF, channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...args: Array<unknown>): Array<Row> } };
type Settings = Record<string, unknown>;
type Core = Awaited<ReturnType<typeof startCore>>;
type LogEntry = Record<string, unknown>;

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'neptunia.ts');
const INTERFACES_DIR = join(REPO, 'tests', 'fixtures', 'interfaces');
const T0 = Date.parse('2026-10-31T12:00:00Z');

/** The private layer of every rig: units mode, the settle wait and typing off, every optional behaviour off. */
const BASE_CONFIG: Settings = {
  bot: { timezone: 'UTC', owners: [], guildId: 'g1' },
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
    innerLife: false,
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
  const privateDir = join(root, 'p');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'config.local.json'), JSON.stringify(merged(BASE_CONFIG, config)));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

/** The client `fake` of kind interface, its token in `<private>/clients/fake.token`, written by the operator's tool. */
function addFakeClient(privateDir: string): void {
  const run = spawnSync(
    process.execPath,
    ['tools/client-token.mjs', 'add', 'fake', '--kind', 'interface', '--iface', 'fake'],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, NEPTUNIA_PRIVATE_DIR: privateDir },
    }
  );
  assert.equal(run.status, 0, `client-token add failed: ${run.stderr}`);
}

/** The scripted model: every request is answered `<msg>` + ANSWER and kept. */
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    complete: (messages: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}
type Llm = ReturnType<typeof scriptedLlm>;

/** The core with no interface of its own, as `interfaces.mode: units` starts it. */
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
  posted(conversationId: string): Promise<Array<string>>;
  kill(signal?: NodeJS.Signals): Promise<void>;
};

function spawnUnit(dirs: Dirs, privateDir = dirs.privateDir): Unit {
  const child = spawn(process.execPath, [BIN, 'interface', 'run', 'fake', '--interfaces-dir', INTERFACES_DIR], {
    cwd: REPO,
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: privateDir, NEPTUNIA_DATA_DIR: dirs.dataDir },
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
    async posted(conversationId) {
      const reply = await unit.ask({ op: 'posted', conversationId }, 'posted');
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

/** A unit that started and holds the conversation c1. */
async function startedUnit(dirs: Dirs, privateDir = dirs.privateDir): Promise<Unit> {
  const unit = spawnUnit(dirs, privateDir);
  await unit.told('started');
  await unit.ask({ op: 'seed-conversation', info: channelInfo('c1') }, 'done');
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

// Case 1 of PR C.
test('a core started with no interface runs a heartbeat turn and records the wake handled', async () => {
  // Sixty clock minutes pass in each real second, so a heartbeat one minute out comes within the wait.
  const realStart = Date.now();
  const now = (): number => T0 + (Date.now() - realStart) * 60;
  await withRig(
    {
      features: { innerLife: true, intentions: false },
      memoryDb: { wakeRuns: true },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 1,
        review: { enabled: false },
        heartbeat: { enabled: true, everyMinutes: 1, jitterMinutes: 0 },
      },
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

// Case 2 of PR C.
test('an interface unit connects with its token, delivers a message and posts her reply', async () => {
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const { acked } = await unit.emit(mention('m1', 'hello bot'));
    assert.equal(await acked, 'ok');
    await until(() => llm.requests.length === 1, 'the turn of m1');
    const posted = await postedOnce(unit, 1);
    assert.deepEqual(posted, [ANSWER]);
    assert.deepEqual(
      query(dirs, "SELECT native_id FROM sources WHERE kind = 'seen'").map((row) => row.native_id),
      ['m1']
    );
  });
});

// Case 3 of PR C, the interface killed while the core runs.
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

// Case 3 of PR C, an event that waited in the outbox of a process that died.
test('an event queued while the core was down survives the kill of its unit and is answered once', async () => {
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
    assert.deepEqual(await postedOnce(second, 1), [ANSWER], 'the reply to m2 reaches the new process');
    await pause(300);
    assert.deepEqual(await second.posted('c1'), [ANSWER], 'her reply is sent once');
    assert.equal(llm.requests.length, 2, 'one turn for m1 and one for m2');
    assert.deepEqual(
      query(dirs, "SELECT native_id FROM sources WHERE kind = 'seen' ORDER BY rowid").map((row) => row.native_id),
      ['m1', 'm2']
    );
  });
});

// Case 4 of PR C, a second core over the same data.
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
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'), { context: { dataDir: dirs.dataDir } });
  try {
    applyWakeQueueWrite(handle, { kind: 'wake-queue', op: 'alive', holder: 'core:other', now: renewedAt, ttlMs });
  } finally {
    handle.close();
  }
}

// Case 4 of PR C, another core that renewed `core:alive` within its ttl.
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

// Case 4 of PR C, the boundary: a lease past its ttl is a core that is gone.
test('a start goes ahead when the core:alive lease of another holder expired', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    aliveOfAnotherCore(dirs, T0 - 400_000, 300_000);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    assert.equal(existsSync(join(dirs.dataDir, 'run', 'core.sock')), true);
  });
});

// Case 4 of PR C, a restart: the core that stopped cleanly must not refuse its own successor.
test('a core stopped cleanly lets the next start in at once', async () => {
  await withRig(
    {
      features: { innerLife: true, intentions: false },
      innerLife: { mode: 'shadow', tickSeconds: 1, review: { enabled: false }, heartbeat: { enabled: false } },
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
  JSON.parse(readFileSync(join(dirs.privateDir, 'config.local.json'), 'utf8')) as Settings;

// Case 5 of PR C, the drain runs out.
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
    assert.equal(isRecord(local.interfaces) && isRecord(local.interfaces.fake) && local.interfaces.fake.enabled, false);
    assert.deepEqual(
      core.interfaces.list().map((entry) => [entry.name, entry.enabled, entry.connected]),
      [['fake', false, false]]
    );

    await first.kill('SIGKILL');
    const second = spawnUnit(dirs);
    units.push(second);
    await second.told('started').catch(() => {});
    if (second.child.exitCode === null) {
      await second.ask({ op: 'seed-conversation', info: channelInfo('c1') }, 'done').catch(() => null);
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

// Case 5 of PR C, the drain finishes in time.
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

// Case 5 of PR C, the choice read at start.
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

// Case 6 of PR C.
test('a unit with the wrong token is refused and nothing it sends is taken', async () => {
  await withRig({}, async ({ dirs, llm, units, cores, logs }) => {
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    // The unit's own private folder, whose token file holds a token no client of the core has.
    const strayPrivate = join(dirs.root, 'q');
    mkdirSync(join(strayPrivate, 'clients'), { recursive: true });
    writeFileSync(join(strayPrivate, 'clients', 'fake.token'), `${'0'.repeat(64)}\n`, { mode: 0o600 });
    const unit = spawnUnit(dirs, strayPrivate);
    units.push(unit);
    await unit.told('started').catch(() => {});
    await until(() => helloRefused(logs, 'token'), 'the refusal of the wrong token');
    if (unit.child.exitCode === null) {
      await unit.ask({ op: 'seed-conversation', info: channelInfo('c1') }, 'done').catch(() => null);
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

/** The text of a model request with every run of digits masked: ids, times and dates differ between two runs. */
const shapeOf = (request: unknown): string => JSON.stringify(request).replace(/\d+/g, '#');

// Case 7 of PR C: the in-process start and the unit give her the same request for the same message.
test('the in-process fake and the fake unit give the model the same request for the same message', async () => {
  const inProcess = folders({ interfaces: { mode: 'inprocess' } });
  const inProcessLlm = scriptedLlm();
  try {
    await withCapturedLogs(async () => {
      let running: Awaited<ReturnType<typeof startFake>> | null = null;
      const core = await startCore({
        paths: inProcess.paths,
        env: { OPENROUTER_CORE_KEY: 'test-key' },
        interfaces: [
          {
            name: 'fake',
            start: async (host) => {
              running = await startFake(host, { self: SELF, community: COMMUNITY });
              return running;
            },
          },
        ],
        llm: inProcessLlm,
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        if (running === null) throw new Error('the core never started the fake interface');
        const live: Awaited<ReturnType<typeof startFake>> = running;
        live.adapter.seedConversation(channelInfo('c1'));
        const event = mention('m1', 'hello bot');
        live.adapter.seedEvent(event);
        assert.equal(await live.emit(event), 'ok');
        await until(() => inProcessLlm.requests.length === 1, 'the in-process turn');
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(inProcess.root, { recursive: true, force: true });
  }

  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await until(() => llm.requests.length === 1, 'the unit turn');
    assert.equal(shapeOf(llm.requests[0]), shapeOf(inProcessLlm.requests[0]));
  });
});
