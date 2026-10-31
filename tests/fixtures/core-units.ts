// The core as the units run it, for the tests of the `neptunia` command and of what reaches the core through it.
// `startCore` (src/core.js) runs in the test process with no interface of its own (`interfaces.mode: units`), over
// temporary data and private folders, a scripted model and the tracked prompts. Clients are written by
// tools/client-token.mjs, as an operator writes them. Two kinds of child process connect to the core's socket:
// - `spawnUnit` runs `bin/neptunia.ts interface run fake` over the fake interface of
//   tests/fixtures/interfaces/fake/index.ts and drives it over its IPC channel;
// - `spawnCli` and `runCli` run `bin/neptunia.ts` itself (the chat, `-p`, `doctor`, `errand-runner`) with its stdin
//   and stdout piped.
// Both read `NEPTUNIA_PRIVATE_DIR` and `NEPTUNIA_DATA_DIR`, set to the rig's folders, so nothing reads a real local
// layer. The memory database is read through a second, read-only connection, because the core holds the lock. No
// provider and no platform is reached.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.js';
import { onLog } from '../../src/log.js';
import { openMemoryDb } from '../../src/memory/db/open.js';
import { ANSWER, channelInfo, lineEvent } from './core-over-fake.ts';
import { withCapturedLogs } from './capture-logs.js';
import type { MessageEvent } from '../../src/protocol/adapter.ts';

export { ANSWER };

export type Row = Record<string, unknown>;
export type Settings = Record<string, unknown>;
export type Core = Awaited<ReturnType<typeof startCore>>;
export type LogEntry = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...args: Array<unknown>): Array<Row> } };

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const BIN = join(REPO, 'bin', 'neptunia.ts');
const INTERFACES_DIR = join(REPO, 'tests', 'fixtures', 'interfaces');

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

export const isRecord = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function merged(base: Settings, extra: Settings): Settings {
  const out: Settings = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const old = out[key];
    out[key] = isRecord(old) && isRecord(value) ? merged(old, value) : value;
  }
  return out;
}

/** Waits for `check`; `what` names it in the failure, a function when the failure should read the state at that time. */
export async function until(check: () => boolean, what: string | (() => string), ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A short wait that lets anything the core would still do on its own happen, so a test can assert that nothing did. */
export const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type Dirs = {
  root: string;
  dataDir: string;
  privateDir: string;
  paths: { rootDir: string; privateDir: string; dataDir: string };
};

/** Fresh folders, the private layer's config.local.json the base merged with `config`. Short: a socket path is limited. */
export function folders(config: Settings = {}): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'nc-'));
  const dataDir = join(root, 'd');
  const privateDir = join(root, 'p');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'config.local.json'), JSON.stringify(merged(BASE_CONFIG, config)));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

/** One client of the core: its name, kind, the `iface` of an interface and its permissions. */
export type Client = { name: string; kind: 'interface' | 'cli'; iface?: string; permissions?: ReadonlyArray<string> };

/** The fake interface unit's client and the owner's command line, the clients of most rigs. */
export const FAKE_CLIENT: Client = { name: 'fake', kind: 'interface', iface: 'fake' };
export const CLI_CLIENT: Client = { name: 'cli', kind: 'cli' };

/** Writes the client's entry and its token file `<private>/clients/<name>.token` with tools/client-token.mjs. */
export function addClient(privateDir: string, client: Client): void {
  const args = ['tools/client-token.mjs', 'add', client.name, '--kind', client.kind];
  if (client.iface !== undefined) args.push('--iface', client.iface);
  for (const permission of client.permissions ?? []) args.push('--permission', permission);
  const run = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: privateDir },
  });
  assert.equal(run.status, 0, `client-token add ${client.name} failed: ${run.stderr}`);
}

/** The scripted model: the requests it got, and its `complete`. */
export type Llm = {
  requests: Array<unknown>;
  complete(messages: unknown): Promise<{ text: string; usage: object; estimated: number }>;
};

/** The scripted model: every request is answered `<msg>` + ANSWER and kept. */
export function scriptedLlm(): Llm {
  const requests: Array<unknown> = [];
  return {
    requests,
    complete: (messages: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

/** The core with no interface of its own, as `interfaces.mode: units` starts it. */
export function startUnitsCore(dirs: Dirs, llm: Llm, now?: () => number): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    ...(now === undefined ? {} : { now }),
  });
}

/** `sql` over the rig's memory database, through a read-only connection. */
export function query(dirs: Dirs, sql: string, ...args: Array<unknown>): Array<Row> {
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

/** The native ids of the members' lines the memory database holds, in the order they were written. */
export const seenIds = (dirs: Dirs): Array<unknown> =>
  query(dirs, "SELECT native_id FROM sources WHERE kind = 'seen' ORDER BY rowid").map((row) => row.native_id);

/** Whether the core took a `hello` of the principal `name` (the link logs `link: hello` with its name). */
export const helloTaken = (logs: ReadonlyArray<LogEntry>, name: string): boolean =>
  logs.some((entry) => entry.msg === 'link: hello' && entry.principal === name);

const env = (dirs: Dirs): NodeJS.ProcessEnv => ({
  ...process.env,
  NEPTUNIA_PRIVATE_DIR: dirs.privateDir,
  NEPTUNIA_DATA_DIR: dirs.dataDir,
});

type Reply = Record<string, unknown> & { op: string };

/** One `neptunia interface run fake` child, driven over IPC. */
export type Unit = {
  child: ChildProcess;
  /** Sends a request and resolves with the first reply of `op` to it. */
  ask(request: Record<string, unknown>, op: string): Promise<Reply>;
  /** Resolves with the next message of `op` the child tells by itself. */
  told(op: string): Promise<Reply>;
  /** Emits an event and resolves once the child's emit returned, with the core's ack still to come. */
  emit(event: unknown): Promise<{ acked: Promise<string> }>;
  posted(conversationId: string): Promise<Array<string>>;
  kill(signal?: NodeJS.Signals): Promise<void>;
};

export function spawnUnit(dirs: Dirs): Unit {
  const child = spawn(process.execPath, [BIN, 'interface', 'run', 'fake', '--interfaces-dir', INTERFACES_DIR], {
    cwd: REPO,
    env: env(dirs),
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
export async function startedUnit(dirs: Dirs): Promise<Unit> {
  const unit = spawnUnit(dirs);
  await unit.told('started');
  await unit.ask({ op: 'seed-conversation', info: channelInfo('c1') }, 'done');
  return unit;
}

/** A member's message in c1 that calls the persona. */
export const mention = (id: string, text: string, at = Date.now()): MessageEvent => lineEvent({ id, text, at, mention: true });

/** What `unit` posted to c1 once it posted `count` texts, or after the wait. */
export async function postedOnce(unit: Unit, count: number): Promise<Array<string>> {
  let posted: Array<string> = [];
  for (let i = 0; i < 160; i += 1) {
    posted = await unit.posted('c1');
    if (posted.length >= count) break;
    await settle(50);
  }
  return posted;
}

/** How a `neptunia` child ended. */
export type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** One `neptunia` child with its stdin and stdout piped. */
export type Cli = {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Types one line, as the owner presses Enter. */
  type(line: string): void;
  /** Ends the input, as the owner presses Ctrl-D. */
  end(): void;
  exited: Promise<Exit>;
  kill(): Promise<void>;
};

export function spawnCli(dirs: Dirs, args: ReadonlyArray<string>, extraEnv: NodeJS.ProcessEnv = {}): Cli {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: REPO, env: { ...env(dirs), ...extraEnv }, stdio: 'pipe' });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<Exit>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    type: (line) => void child.stdin.write(`${line}\n`),
    end: () => void child.stdin.end(),
    exited,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const forced = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(forced);
    },
  };
}

/** Runs one `neptunia` command to its end, with its input closed; a run past `ms` is killed and fails the test. */
export async function runCli(
  dirs: Dirs,
  args: ReadonlyArray<string>,
  ms = 15000
): Promise<Exit & { stdout: string; stderr: string }> {
  const cli = spawnCli(dirs, args);
  cli.end();
  const timer = setTimeout(() => void cli.kill(), ms);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia ${args.join(' ')} did not end within ${ms} ms:\n${cli.stderr().slice(-2000)}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}

export type Rig = {
  dirs: Dirs;
  llm: Llm;
  units: Array<Unit>;
  clis: Array<Cli>;
  cores: Array<Core>;
  logs: Array<LogEntry>;
};

/**
 * Runs `body` over fresh folders with `clients` written, stopping every unit, chat and core it registered and
 * removing the folders after. The core's log entries are kept in `logs` as they are written.
 */
export async function withRig(
  options: { config?: Settings; clients?: ReadonlyArray<Client> },
  body: (rig: Rig) => Promise<void>
): Promise<void> {
  const dirs = folders(options.config ?? {});
  for (const client of options.clients ?? [FAKE_CLIENT, CLI_CLIENT]) addClient(dirs.privateDir, client);
  const llm = scriptedLlm();
  const units: Array<Unit> = [];
  const clis: Array<Cli> = [];
  const cores: Array<Core> = [];
  const logs: Array<LogEntry> = [];
  const stop = onLog((entry: object) => {
    logs.push({ ...entry });
  });
  try {
    await withCapturedLogs(async () => {
      try {
        await body({ dirs, llm, units, clis, cores, logs });
      } finally {
        for (const cli of clis) await cli.kill();
        for (const unit of units) await unit.kill();
        for (const core of cores) await core.stop();
      }
    });
  } finally {
    stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}
