// A second instance of the public engine beside a first one. The tracked tree is copied twice (`git ls-files`) into
// a temporary folder, once as each instance's "engine". Each instance gets its own private layer (`config.local/`,
// `prompts.local/`), its own data folder and so its own socket, and runs as a child process (tests/fixtures/
// instance-runner.ts) with a scripted model and the fake interface, both started at the same moment. One message goes
// through each to a reply. The checks then look at what each instance did to the disk, to the sockets and to the
// memory database: nothing of the engine copies changed, every file an instance created sits in its own folders, the
// sockets and the open files of each child name only its own folders, and neither memory.db holds a row or a prompt
// of the other. Nothing here reads the real checkout's layers, `data/` or a `.env`, and no provider is called.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.ts';
import { channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import type { InstanceCommand, InstanceReady, InstanceReply } from './fixtures/instance-protocol.ts';
import { chainsOf } from './fixtures/chains.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
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
  writeFileSync(join(one.privateDir, 'prompts', 'character-card.md'), `${one.persona}. You are a quiet guest.\n`);
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
  for (const name of NAMES) world[name]?.child.kill('SIGKILL');
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

test('every file the run created sits in the data folder of one of the two instances', () => {
  const created = changes(world.rootBefore, world.rootAfter);
  assert.ok(created.length > 0, 'the instances wrote their data');
  const dataFolders = NAMES.map((name) => join(name, 'data'));
  const stray = created.filter((path) => !dataFolders.some((folder) => isWithin(path, folder)));
  assert.deepEqual(stray, []);
});

test('each data folder holds its own database, its own socket and its own writer lock', () => {
  const sockets = NAMES.map((name) => join(world[name].dataDir, 'run', 'core.sock'));
  assert.equal(new Set(sockets).size, 2, 'the two sockets are two paths');
  for (const name of NAMES) {
    assert.equal(existsSync(join(world[name].dataDir, 'run', 'core.sock')), true, `${name} listens`);
    assert.equal(existsSync(lockPathOf(join(world[name].dataDir, 'memory.db'))), true, `${name} holds its lock`);
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
      assert.equal(isWithin(file, REPO.replace(/\/$/, '')), false, `${name} has ${file} open`);
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
    assert.equal(world.requests[name].length, 1, 'one model request');
    const text = world.requests[name][0] ?? '';
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
