// Tests for src/memory/db/open.ts: migrations, the writer lock, read-only mode, and the open of a database at the
// schema baseline or below it, over temporary files (never the deployment's data/).
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import path, { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, lockPathOf, openMemoryDb, schemaVersion, acquireLock } from '../../../../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../../../../src/memory/db/schema-baseline.ts';
import { filledRows, schemaShape } from '../../../fixtures/memory-db/schema-shape.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import { START } from '../../../fixtures/boundary.ts';
import { tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { FAKE_CLIENT, startUnitsCore, withRig } from '../../../fixtures/core-units.ts';
import type { Rig } from '../../../fixtures/core-units.ts';
import { channelInfo, lineEvent } from '../../../fixtures/core-over-fake.ts';
import type { InstanceCommand, InstanceReady, InstanceReply } from '../../../fixtures/instance-protocol.ts';
import { chainsOf } from '../../../fixtures/chains.ts';

const names = (db: Db, type = 'table') =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((row) => row.name as string);

test('a file database runs in WAL with foreign keys on and reopens without migrating twice', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const first = openMemoryDb(file);
  assert.equal(dbOf(first).prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(dbOf(first).prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.ok((dbOf(first).prepare('PRAGMA busy_timeout').get()!.timeout as number) > 0);
  dbOf(first).prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
  first.close();
  const second = openMemoryDb(file);
  // A new database starts at the baseline with one version row (src/memory/db/schema-baseline.ts) and one more per step
  // above it; a second migration would add rows.
  assert.equal(dbOf(second).prepare('SELECT COUNT(*) AS n FROM schema_version').get()!.n, 1 + MIGRATIONS.length);
  assert.equal(dbOf(second).prepare("SELECT value FROM meta WHERE key = 'k'").get()!.value, 'v');
  second.close();
});

test('a later migration is applied on top and the shipped ones are not run again', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file).close();
  const next = [...MIGRATIONS, 'CREATE TABLE extra_table (id TEXT PRIMARY KEY);'];
  const handle = openMemoryDb(file, { migrations: next });
  // The versions count from the baseline (src/memory/db/schema-baseline.ts), one per step above it.
  assert.equal(schemaVersion(dbOf(handle)), BASELINE_VERSION + MIGRATIONS.length + 1);
  assert.ok(names(dbOf(handle)).includes('extra_table'));
  handle.close();
});

test('a failing migration rolls back whole and leaves the version where it was', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file).close();
  const broken = [...MIGRATIONS, 'CREATE TABLE half (id TEXT); THIS IS NOT SQL;'];
  assert.throws(() => openMemoryDb(file, { migrations: broken }));
  const handle = openMemoryDb(file);
  // The versions count from the baseline (src/memory/db/schema-baseline.ts), one per step above it.
  assert.equal(schemaVersion(dbOf(handle)), BASELINE_VERSION + MIGRATIONS.length);
  assert.ok(!names(dbOf(handle)).includes('half'));
  handle.close();
});

test('transaction commits on return and rolls back on a throw', () => {
  const handle = openMemoryDb(':memory:');
  handle.transaction(() => dbOf(handle).prepare("INSERT INTO meta (key, value) VALUES ('a', 1)").run());
  assert.throws(
    () =>
      handle.transaction(() => {
        dbOf(handle).prepare("INSERT INTO meta (key, value) VALUES ('b', 2)").run();
        throw new Error('boom');
      }),
    /boom/
  );
  const keys = dbOf(handle)
    .prepare('SELECT key FROM meta ORDER BY key')
    .all()
    .map((row) => row.key);
  assert.deepEqual(keys, ['a']);
  assert.equal(
    handle.transaction(() => 7),
    7
  );
  handle.close();
});

test('the writer lock holds the pid and start time and goes away on close', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file, { pid: 4242, now: () => Date.UTC(2026, 9, 24, 8, 0, 0), alive: () => false });
  const lock = JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8'));
  assert.deepEqual(lock, { pid: 4242, startedAt: '2026-10-24T08:00:00.000Z' });
  handle.close();
  assert.ok(!fs.existsSync(lockPathOf(file)));
});

test('a lock of a live pid refuses with a clear error and leaves the lock alone', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 777, startedAt: '2026-10-24T07:00:00.000Z' }));
  assert.throws(() => openMemoryDb(file, { pid: 1, alive: (pid) => pid === 777 }), /locked by pid 777/);
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 777);
});

test('a lock of a dead pid, or an unreadable one, is taken over', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 777, startedAt: 'x' }));
  const first = openMemoryDb(file, { pid: 11, alive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 11);
  first.close();
  fs.writeFileSync(lockPathOf(file), 'not json');
  const second = openMemoryDb(file, { pid: 12, alive: () => true });
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 12);
  second.close();
});

test('the real process check: this process holds the lock, a second open in it refuses', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file);
  assert.throws(() => openMemoryDb(file), /locked by pid/);
  handle.close();
  openMemoryDb(file).close();
});

test('a close that lost its lock to another process leaves the other lock in place', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file, { pid: 5, alive: () => false });
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 6, startedAt: 'x' }));
  handle.close();
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 6);
});

test('read-only mode takes no lock, reads while a writer holds the file, and refuses to write', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  dbOf(writer).prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
  const reader = openMemoryDb(file, { readOnly: true });
  assert.equal(dbOf(reader).prepare("SELECT value FROM meta WHERE key = 'k'").get()!.value, 'v');
  assert.throws(() => dbOf(reader).prepare("INSERT INTO meta (key, value) VALUES ('x', 1)").run());
  assert.throws(() => reader.transaction(() => 1), /read-only/);
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, process.pid);
  reader.close();
  assert.ok(fs.existsSync(lockPathOf(file)), 'closing a reader leaves the writer lock');
  writer.close();
});

test('read-only mode of a file that does not exist throws', () => {
  const dir = tempDir('nep-memdb-');
  assert.throws(() => openMemoryDb(path.join(dir, 'missing.db'), { readOnly: true }));
});

test('closing twice is harmless', () => {
  const handle = openMemoryDb(':memory:');
  handle.close();
  handle.close();
});

// ---- the schema baseline ---------------------------------------------------------------------------------------------

const versions = (handle: ReturnType<typeof openMemoryDb>): Array<number> =>
  dbOf(handle)
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((row) => Number(row.version));

/** The versions a current database holds: the baseline's, then one per step above it. */
const CURRENT = [BASELINE_VERSION, ...MIGRATIONS.map((_, step) => BASELINE_VERSION + step + 1)];

test('a database at the baseline opens with its schema, rows and version unchanged', () => {
  // Catches: an open that runs a step again, adds an object or a seed row, or writes a version, on a current file.
  const file = path.join(tempDir('nep-baseline-'), 'memory.db');
  const first = openMemoryDb(file);
  const shape = schemaShape(dbOf(first));
  const rows = filledRows(dbOf(first));
  first.close();
  const again = openMemoryDb(file);
  try {
    assert.deepEqual(schemaShape(dbOf(again)), shape);
    assert.deepEqual(filledRows(dbOf(again)), rows);
    assert.deepEqual(versions(again), CURRENT);
    assert.equal(dbOf(again).prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally {
    again.close();
  }
});

test('refuses a database below the baseline with the version it found and leaves the file as it was', () => {
  // Catches: an open that runs half a schema over an old file, or refuses it without saying what to do.
  const file = path.join(tempDir('nep-baseline-'), 'old.db');
  const old = new DatabaseSync(file);
  // The version below the baseline 56 is 55.
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (55);');
  old.close();
  assert.throws(() => openMemoryDb(file), /schema-below-baseline: .*version 55.*baseline 56/);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    assert.deepEqual(
      tables.map((row) => row.name),
      ['schema_version']
    );
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 55);
  } finally {
    after.close();
  }
});

// The boundary tests of the core extraction (plan 2026-10-25, stage 1): six properties every later stage is measured
// by, driven through public exports over the fake interface adapter, the real event door, the real turn runner and a
// real memory database, with a scripted model. Some hold today and are asserted; the ones the extraction builds are
// `test.todo` with the stage that removes the mark. No Discord client is started and no model is called.
describe('the writer lock', () => {
  const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

  /** The rigs and services a test opened; closed when the file is done. */
  const OPEN: Array<{ close(): unknown }> = [];
  after(async () => {
    for (const item of OPEN) await item.close();
  });

  describe('one writer', () => {
    const UNIT = 'guilds/g1/journal/2026-10-26.jsonl';
    const line = (id: string) => ({
      id,
      kind: 'turn.start',
      occurredAt: '2026-10-26T12:00:00.000Z',
      turnId: id,
    });

    test('a writer lock held by another live process refuses the open and leaves the file alone', async () => {
      const dataDir = tempDataDir('boundary-writer-');
      const dbPath = path.join(dataDir, 'memory.db');
      fs.writeFileSync(
        lockPathOf(dbPath),
        JSON.stringify({ pid: process.ppid, startedAt: '2026-10-26T11:00:00.000Z' })
      );
      assert.throws(() => openMemoryDb(dbPath), /is locked by pid/);
      const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
      const rival = createMemoryDb({ iface: () => 'discord', hot, dataDir, log: SILENT, now: () => START });
      OPEN.push({ close: () => rival.close() });
      await rival.tick();
      assert.equal(rival.readHandle(), null, 'the service did not open the database');
      await assert.rejects(writeUnitUpdate(rival, { op: 'lines', file: UNIT, lines: [line('x1')] }), {
        code: 'DB_CLOSED',
      });
      assert.match(
        fs.readFileSync(lockPathOf(dbPath), 'utf8'),
        new RegExp(`"pid":${process.ppid}\\b`),
        'the holder keeps its lock'
      );
    });
  });
});

// A maintenance tool holds the writer the way `acquireLock` does while the core is down or starting, and a message
// reaches the interface unit meanwhile. The core opens the live data folder of a fresh install over its own database.

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** One install: its rig and the database file in its data folder, created at the current schema. */
type World = { rig: Rig; db: string };

const maintained = (body: (w: World) => void | Promise<void>): Promise<void> =>
  withRig({ clients: [FAKE_CLIENT] }, async (rig) => {
    const db = path.join(rig.dirs.dataDir, 'memory.db');
    openMemoryDb(db).close();
    await body({ rig, db });
  });

test('a core cannot start while maintenance holds the writer, and the refused start writes nothing', () =>
  maintained(async (w) => {
    // Bug: a second writer opens the database under a maintenance tool and lands a line in it.
    const { dirs, llm } = w.rig;
    const before = sha256(w.db);
    const release = acquireLock(w.db);
    try {
      await assert.rejects(startUnitsCore(dirs, llm), /locked/);
      assert.equal(
        fs.existsSync(path.join(dirs.dataDir, 'run', 'core.sock')),
        false,
        'the refused start left a socket'
      );
    } finally {
      release();
    }
    assert.equal(sha256(w.db), before);
    assert.equal(fs.existsSync(lockPathOf(w.db)), false, 'maintenance released the lock');
  }));

// A second instance of the public engine beside a first one. The tracked tree is copied twice (`git ls-files`) into
// a temporary folder, once as each instance's "engine". Each instance gets its own private layer (`config.local/`,
// `prompts.local/`), its own data folder and so its own socket, and runs as a child process (tests/fixtures/
// instance-runner.ts) with a scripted model and the fake interface, both started at the same moment. One message goes
// through each to a reply. The checks then look at what each instance did to the disk, to the sockets and to the
// memory database: nothing of the engine copies changed, every file an instance created sits in its own folders, the
// sockets and the open files of each child name only its own folders, and neither memory.db holds a row or a prompt
// of the other. Nothing here reads the real checkout's layers, `data/` or a `.env`, and no provider is called.
describe('two instances on separate data folders', () => {
  const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
  const RUNNER = join(REPO, 'tests', 'fixtures', 'instance-runner.ts');
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

  /** The tracked tree of the checkout, file by file, into `to`: the public engine as a clean clone holds it. */
  function copyTrackedTree(to: string): void {
    const listed = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    for (const file of listed.split('\0').filter((name) => name !== '')) {
      const from = join(REPO, file);
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

  async function until(check: () => Promise<boolean>, ms = 10000): Promise<void> {
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
    await until(async () => (await postedOf(alpha)).length === 1 && (await postedOf(beta)).length === 1);
    await until(() => Promise.resolve(sourceTexts(alpha).length >= 2 && sourceTexts(beta).length >= 2));
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

  test('each data folder holds its own database, its own socket and its own writer lock', () => {
    const sockets = NAMES.map((name) => join(world[name].dataDir, 'run', 'core.sock'));
    assert.equal(new Set(sockets).size, 2, 'the two sockets are two paths');
    for (const name of NAMES) {
      assert.equal(existsSync(join(world[name].dataDir, 'run', 'core.sock')), true, `${name} listens`);
      assert.equal(existsSync(lockPathOf(join(world[name].dataDir, 'memory.db'))), true, `${name} holds its lock`);
    }
  });
});
