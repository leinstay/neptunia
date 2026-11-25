// Runtime privateDir names the selected persona data directory. Each case injects its own environment.
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import path, { dirname, join, sep } from 'node:path';
import { resolvePaths } from '../../src/paths.ts';
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
import { createHot as createHotUntyped } from '../../src/hot.ts';
import { readConfig } from '../../src/config.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { profileOf } from '../../src/agent-runner/profiles.ts';
import { fixture as agentFixture } from '../fixtures/agent-overrides.ts';
import { tempDir } from '../fixtures/tmp.ts';
import { spawnSync, execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { channelInfo, lineEvent } from '../fixtures/core-over-fake.ts';
import type { InstanceCommand, InstanceReady, InstanceReply } from '../fixtures/instance-protocol.ts';
import { chainsOf } from '../fixtures/chains.ts';

const ROOT = path.resolve('/opt/engine');

test('resolvePaths: with neither variable set, personal material lives in root/data', () => {
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: {} }), {
    rootDir: ROOT,
    privateDir: path.join(ROOT, 'data'),
    dataDir: path.join(ROOT, 'data'),
  });
});

test('resolvePaths: a blank variable counts as unset', () => {
  const paths = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_DATA_DIR: '   ' } });
  assert.equal(paths.privateDir, path.join(ROOT, 'data'));
  assert.equal(paths.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: absolute values are taken as they are', () => {
  const dataDir = path.resolve('/var/lib/engine-data');
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_DATA_DIR: dataDir } }), {
    rootDir: ROOT,
    privateDir: dataDir,
    dataDir,
  });
});

test('resolvePaths: relative values are resolved against the root, not the working directory', () => {
  const paths = resolvePaths({
    rootDir: ROOT,
    env: { NEPTUNIA_DATA_DIR: 'state/memory' },
  });
  assert.equal(paths.privateDir, path.join(ROOT, 'state', 'memory'));
  assert.equal(paths.dataDir, path.join(ROOT, 'state', 'memory'));
});

test('resolvePaths: a relative root comes back absolute', () => {
  const onlyData = resolvePaths({ rootDir: 'engine', env: { NEPTUNIA_DATA_DIR: 'mem' } });
  assert.equal(onlyData.rootDir, path.resolve('engine'));
  assert.equal(onlyData.privateDir, path.resolve('engine', 'mem'));
  assert.equal(onlyData.dataDir, path.resolve('engine', 'mem'));
});

// Canonical persona configuration and labels merge over engine defaults.
// Existing merge, targeted-write, watcher and interface precedence controls retain their values.

type Tree = Record<string, unknown>;

function write(dir: string, rel: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(value));
}

/** What these tests read of the live view (src/hot.ts). */
type Hot = {
  config: Tree;
  prompts: Record<string, unknown> & { labels: Tree };
  reloadConfig: () => boolean;
  reloadPrompts: () => boolean;
  onReload: (listener: (what: string) => void) => () => void;
  watch: () => Hot;
  close: () => void;
};

const createHot = (options: { rootDir: string; privateDir: string; watchImpl?: unknown }): Hot =>
  createHotUntyped({
    rootDir: options.rootDir,
    privateDir: options.privateDir,
    ...(options.watchImpl === undefined ? {} : { watchImpl: options.watchImpl as typeof fs.watch }),
  });

// A copied persona must retain its effective settings and identity after the original install disappears.
test('a copied persona supplies configuration, prompts, keys and agent overrides without its original root', () => {
  const original = agentFixture();
  write(original.rootDir, 'config/config.json', { pace: { settleMs: 500, settleMaxMs: 3000 } });
  write(original.rootDir, 'config/labels.json', { model: { copied: 'base label' }, owner: {} });
  fs.mkdirSync(path.join(original.rootDir, 'prompts'));
  fs.writeFileSync(path.join(original.rootDir, 'prompts/rules.md'), 'base rules');
  write(original.dataDir, 'config/config.json', { pace: { settleMs: 900 } });
  write(original.dataDir, 'config/labels.json', { model: { copied: 'personal label' }, owner: {} });
  fs.mkdirSync(path.join(original.dataDir, 'prompts'));
  fs.writeFileSync(path.join(original.dataDir, 'prompts/rules.md'), 'personal rules');
  // Changed: keys.json holds named keys under `keys` (spec 2026-11-09-model-routes, slice 4).
  write(original.dataDir, 'keys.json', { keys: { 'core-1': 'synthetic-portable-key' } });
  original.override({ limits: { steps: 6 } });
  fs.writeFileSync(path.join(original.personal, 'prompt.md'), 'personal worker instructions');
  const copied = tempDir('nep-persona-copied-');
  const rootDir = path.join(copied, 'engine');
  const dataDir = path.join(copied, 'persona');
  fs.cpSync(original.rootDir, rootDir, { recursive: true });
  fs.cpSync(original.dataDir, dataDir, { recursive: true });
  fs.renameSync(original.base, `${original.base}-unavailable`);
  const paths = resolvePaths({ rootDir, env: { NEPTUNIA_DATA_DIR: dataDir } });
  assert.deepEqual(readConfig(rootDir, { privateDir: paths.privateDir }), {
    pace: { settleMs: 900, settleMaxMs: 3000 },
  });
  const hot = createHot({ rootDir, privateDir: paths.privateDir });
  try {
    assert.equal(hot.prompts.rules, 'personal rules');
    assert.deepEqual(hot.prompts.labels, { copied: 'personal label' });
    assert.equal(createKeyStore({ privateDir: paths.privateDir }).valueOf('core-1'), 'synthetic-portable-key');
    const profile = profileOf('scout', { rootDir, dataDir, env: {} });
    assert.equal(profile?.defaultLimits.steps, 6);
    assert.equal(profile?.promptFiles[0], path.join(dataDir, 'agents/scout/prompt.md'));
  } finally {
    hot.close();
  }
});

// The public repository holds exactly one file of the persona root, its generic README. Runs `git check-ignore`
// against the repository's own `.gitignore`.

function isIgnored(file: string): boolean {
  return spawnSync('git', ['check-ignore', '--quiet', '--no-index', file]).status === 0;
}

test('keeps only the generic README of the persona root trackable', () => {
  // Bug: a widened allowlist lets `git add` take the persona's prompts, settings, memory or a key into the public repo.
  assert.equal(isIgnored('data/README.md'), false);
  for (const file of [
    'data/memory.db',
    'data/keys.json',
    'data/config/config.json',
    'data/prompts/persona.md',
    'data/prompts/README.md',
    'data/interfaces/discord/credentials.json',
    'data/skills/any/SKILL.md',
    'data/subharness/claude/home/.credentials.json',
    // The persona's files live under media/diary.
    'data/media/diary/a.png',
    'data/.gitignore',
  ]) {
    assert.equal(isIgnored(file), true, file);
  }
});

// A second instance of the public engine beside a first one. The tracked tree is copied twice (`git ls-files`) into
// a temporary folder, once as each instance's "engine". Each instance gets its own private layer (`config.local/`,
// `prompts.local/`), its own data folder and so its own socket, and runs as a child process (tests/fixtures/
// instance-runner.ts) with a scripted model and the fake interface, both started at the same moment. One message goes
// through each to a reply. The checks then look at what each instance did to the disk, to the sockets and to the
// memory database: nothing of the engine copies changed, every file an instance created sits in its own folders, the
// sockets and the open files of each child name only its own folders, and neither memory.db holds a row or a prompt
// of the other. Nothing here reads the real checkout's layers, `data/` or a `.env`, and no provider is called.

const REPO = fileURLToPath(new URL('../..', import.meta.url));
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
type SecondInstanceTree = Map<string, Stat>;

const settings = (placeId: string) => ({
  bot: { timezone: 'UTC', owners: [], placeId },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
});

/** Every file under `dir` (sockets included) as a path relative to it, with its size and modification time. */
function walk(dir: string): SecondInstanceTree {
  const tree: SecondInstanceTree = new Map();
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
function changes(before: SecondInstanceTree, after: SecondInstanceTree): Array<string> {
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
  engineBefore: Record<Name, SecondInstanceTree>;
  layerBefore: Record<Name, SecondInstanceTree>;
  rootBefore: SecondInstanceTree;
  rootAfter: SecondInstanceTree;
  requests: Record<Name, Array<string>>;
  posted: Record<Name, Array<string>>;
  open: Record<Name, ReturnType<typeof openPaths>>;
  stop(): Promise<void>;
} = {} as never; // filled in `before`, read by every test below: the two children run once for all of them

// Only configuration and prompt inputs stay immutable; runtime records share their canonical data root.
const personalFiles = (dir: string): SecondInstanceTree =>
  new Map(
    [...walk(dir)].filter(([at]) => ['config', 'prompts'].some((part) => at === part || at.startsWith(`${part}/`)))
  );

const textOf = (name: Name): string => `question to ${name}`;
describe('a second instance', () => {
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

  test('every file the run created sits in the data folder of one of the two instances', () => {
    const created = changes(world.rootBefore, world.rootAfter);
    assert.ok(created.length > 0, 'the instances wrote their data');
    const dataFolders = NAMES.map((name) => join(name, 'data'));
    const stray = created.filter((path) => !dataFolders.some((folder) => isWithin(path, folder)));
    assert.deepEqual(stray, []);
  });
});
