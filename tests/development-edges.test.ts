// What the development worker runs on (src/development/edges.ts): its working repository is `selfimprovement.checkout`,
// its worktrees live in that checkout and git never sees them as changes, nothing of development lands in the persona
// folder but a skill's package, and an agent gets no gh access: an empty gh home of its own for one run. A real local
// git in a temp folder, a fake `gh` on PATH, and fake backend executables at the spawn boundary. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { developmentEdges } from '../src/development/edges.ts';
import type { DevelopmentEdges } from '../src/development/edges.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

type Rig = { checkout: string; dataDir: string; bin: string; edges: DevelopmentEdges };

function rig(env: Readonly<NodeJS.ProcessEnv> = {}): Rig {
  const checkout = tempDir('nep-edges-checkout-');
  const dataDir = tempDir('nep-edges-data-');
  const bin = tempDir('nep-edges-bin-');
  const edges = developmentEdges({
    checkout,
    privateDir: dataDir,
    dataDir,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    denyDir: path.join(tempDir('nep-edges-deny-'), 'nosudo'),
    tmpDir: os.tmpdir(),
  });
  return { checkout, dataDir, bin, edges };
}

const gitIn = (dir: string, ...args: ReadonlyArray<string>): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.test', '-c', 'init.defaultBranch=main', ...args],
    { cwd: dir, encoding: 'utf8' }
  );

function realRepository(dir: string): void {
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\n');
  gitIn(dir, 'add', 'README.md');
  gitIn(dir, 'commit', '-q', '-m', 'first');
}

/** Every file under `dir`, as paths from it; nothing is an empty list. */
function filesUnder(dir: string): Array<string> {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** The rig's world on these edges' paths: the board and the fake commands stay the world's. */
function worldOn(t: Parameters<typeof developmentWorld>[0], { edges }: Rig): DevelopmentWorld {
  const world = developmentWorld(t);
  world.deps.repoDir = edges.repoDir;
  // placeTree links the checkout's node_modules into each worktree and refuses a checkout without them.
  fs.mkdirSync(path.join(edges.repoDir, 'node_modules', '.bin'), { recursive: true });
  world.deps.worktreeRoot = edges.worktreeRoot;
  return world;
}

// ---------- the working repository and its worktrees ----------

test('the worker refuses to start without selfimprovement.checkout, naming it', () => {
  // Catches: the worker falls back to the installed checkout and edits the code that is running.
  assert.throws(
    () =>
      developmentEdges({
        checkout: null,
        privateDir: '/nowhere',
        dataDir: '/nowhere',
        env: {},
        denyDir: '/nowhere/deny',
        tmpDir: '/nowhere/tmp',
      }),
    /selfimprovement\.checkout/
  );
});

test('the working repository is the checkout, and the worktrees sit in its .worktrees folder', () => {
  // Catches: worktrees under the persona folder, or git run in the install.
  const { checkout, edges } = rig();
  assert.equal(edges.repoDir, checkout);
  assert.equal(edges.worktreeRoot, path.join(checkout, '.worktrees'));
});

test('a task runs in <checkout>/.worktrees/<task>, with git run from the checkout', async (t) => {
  // Catches: the paths are right in the edges and the worker still builds its own.
  const on = rig();
  const world = worldOn(t, on);
  const id = ownerTask(world);
  await settle(world.worker());
  const tree = path.join(on.checkout, '.worktrees', id);
  assert.equal(world.runsOf('thinker')[0]?.cwd, tree);
  const add = world.git.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.equal(add?.cwd, on.checkout);
  assert.equal(add?.args.includes(tree), true);
});

test('a worktree never shows as a change of the checkout', () => {
  // Catches: `git status` of the checkout lists `.worktrees/`, and a `git add .` there commits every task.
  const { checkout, edges } = rig();
  realRepository(checkout);
  edges.prepare();
  gitIn(checkout, 'worktree', 'add', '-q', '-b', 'self/T-1', path.join(edges.worktreeRoot, 'T-1'), 'HEAD');
  fs.writeFileSync(path.join(edges.worktreeRoot, 'T-1', 'left.txt'), 'x\n');
  assert.equal(gitIn(checkout, 'status', '--porcelain'), '');
});

test('the exclusion goes in .git/info/exclude once, beside what is there, and not in .gitignore', () => {
  // Catches: a tracked .gitignore edited in the owner's checkout, a line added at each start, or his rules overwritten.
  const { checkout, edges } = rig();
  realRepository(checkout);
  const exclude = path.join(checkout, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, 'my-notes/\n');
  edges.prepare();
  edges.prepare();
  const lines = fs.readFileSync(exclude, 'utf8').split('\n');
  assert.equal(lines.includes('my-notes/'), true);
  assert.equal(lines.filter((line) => line.includes('.worktrees')).length, 1);
  assert.equal(fs.existsSync(path.join(checkout, '.gitignore')), false);
});

test('a whole task from filing to pull request writes nothing in the persona folder', async (t) => {
  // Catches: `data/development` back in some other name.
  const on = rig();
  const world = worldOn(t, on);
  ownerTask(world);
  await settle(world.worker());
  assert.equal(world.created, 1);
  assert.deepEqual(filesUnder(on.dataDir), []);
});

test("a skill task's package is all it leaves in the persona folder, under skills", async (t) => {
  // Catches: a skill's work spread over the persona folder, or a worktree of it kept there.
  const on = rig();
  const world = worldOn(t, on);
  world.scripts.thinker = () => {
    fs.mkdirSync(path.join(on.dataDir, 'skills', 'web-read'), { recursive: true });
    fs.writeFileSync(path.join(on.dataDir, 'skills', 'web-read', 'SKILL.md'), '# package\n');
  };
  const answer = await herCalls(world.caller)('task.propose', { ...FIX_REQUEST, kind: 'skill' });
  const id = String((answer.data as { task: { id: string } }).task.id);
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'needs_validation');
  assert.deepEqual(filesUnder(on.dataDir), [path.join('skills', 'web-read', 'SKILL.md')]);
  assert.equal(world.runsOf('thinker')[0]?.cwd, path.join(on.checkout, '.worktrees', id));
});

// ---------- the worker's own gh and git ----------

function installFakeGh(bin: string): void {
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "config=${GH_CONFIG_DIR-unset} token=${GH_TOKEN-unset}"\n', {
    mode: 0o755,
  });
}

test("the worker's gh runs on the system's login: no config home of ours, its token untouched", async () => {
  // Catches: the worker keeps a private gh home and cannot see the login `gh auth login` made.
  const { checkout, bin, edges } = rig({ GH_TOKEN: 'system-token' });
  installFakeGh(bin);
  const answer = await edges.gh('gh', ['auth', 'status'], { cwd: checkout });
  assert.equal(answer.stdout.trim(), 'config=unset token=system-token');
});

test("the worker's git authenticates github.com through gh, with no config home of ours", async () => {
  // Catches: a push asks a terminal in a unit, or goes through a login other than the system's.
  const { checkout, edges } = rig();
  realRepository(checkout);
  const helpers = await edges.git('git', ['config', '--get-all', 'credential.https://github.com.helper'], {
    cwd: checkout,
  });
  assert.equal(helpers.stdout.includes('!gh auth git-credential'), true);
  const env = await edges.git('git', ['-c', 'alias.seen=!printenv GH_CONFIG_DIR', 'seen'], { cwd: checkout });
  assert.equal(env.stdout.trim(), '');
});

// ---------- an agent's environment ----------

/** A fake claude that records its environment and what its gh home holds, then exits with `code`. */
function installFakeClaude(dataDir: string, record: string, code = 0): void {
  writeKeysFile(dataDir, { subharness: { backends: ['claude'], key: null, modes: {} } });
  const { binary } = subharnessPlace(dataDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    `#!/bin/sh
# The engine reads the backend's help to learn its flags; that is no agent run.
case "$1" in --help) exit 0;; esac
{
  echo "home=\${GH_CONFIG_DIR-unset}"
  echo "token=\${GH_TOKEN-unset}"
  echo "github=\${GITHUB_TOKEN-unset}"
  [ -d "\${GH_CONFIG_DIR-/nowhere}" ] && echo "exists=yes" || echo "exists=no"
  echo "holds=$(ls -A "\${GH_CONFIG_DIR-/nowhere}" 2>/dev/null | wc -l | tr -d ' ')"
} >> "${record}"
cat > /dev/null
echo finished
exit ${code}
`,
    { mode: 0o755 }
  );
}

const fieldsOf = (record: string, name: string): Array<string> =>
  fs
    .readFileSync(record, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));

const AN_AGENT_RUN = { agent: 'dev', brief: 'Do it.', timeoutMs: 20_000 };

test('an agent run gets an empty gh home of its own, outside the checkout and the persona, gone after the run', async () => {
  // Catches: a home shared between runs, one left behind, or one an agent can fill for the next.
  const { checkout, dataDir, edges } = rig();
  const record = path.join(tempDir('nep-edges-record-'), 'record');
  installFakeClaude(dataDir, record);
  await edges.runAgent({ ...AN_AGENT_RUN, cwd: checkout });
  await edges.runAgent({ ...AN_AGENT_RUN, cwd: checkout });
  const homes = fieldsOf(record, 'home');
  assert.equal(new Set(homes).size, 2);
  assert.deepEqual(fieldsOf(record, 'exists'), ['yes', 'yes']);
  assert.deepEqual(fieldsOf(record, 'holds'), ['0', '0']);
  for (const home of homes) {
    assert.equal(fs.existsSync(home), false, home);
    assert.equal(home.startsWith(checkout) || home.startsWith(dataDir), false, home);
  }
});

test("an agent's own gh home wins over anything the worker hands it, and no token reaches it", async (t) => {
  // Catches: a thinker able to merge through a token inherited or passed along, past the code's CI read.
  const { checkout, dataDir, edges } = rig({ GH_TOKEN: 'system-token', GITHUB_TOKEN: 'system-token' });
  process.env.GH_TOKEN = 'system-token';
  t.after(() => {
    delete process.env.GH_TOKEN;
  });
  const record = path.join(tempDir('nep-edges-record-'), 'record');
  installFakeClaude(dataDir, record);
  await edges.runAgent({
    ...AN_AGENT_RUN,
    cwd: checkout,
    env: { GH_CONFIG_DIR: '/home/someone/.config/gh', GH_TOKEN: 'passed-along', GITHUB_TOKEN: 'passed-along' },
  });
  assert.deepEqual(fieldsOf(record, 'token'), ['unset']);
  assert.deepEqual(fieldsOf(record, 'github'), ['unset']);
  assert.notEqual(fieldsOf(record, 'home')[0], '/home/someone/.config/gh');
});

test('the gh home goes after a failed run too, and after a run that never started', async () => {
  // Catches: the temp folders pile up exactly when something is wrong.
  const { checkout, dataDir, edges } = rig();
  const record = path.join(tempDir('nep-edges-record-'), 'record');
  installFakeClaude(dataDir, record, 3);
  const failed = await edges.runAgent({ ...AN_AGENT_RUN, cwd: checkout });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(fieldsOf(record, 'home')[0] ?? ''), false);

  const tmpDir = tempDir('nep-edges-tmp-');
  const off = rig();
  const refusing = developmentEdges({
    checkout: off.checkout,
    privateDir: off.dataDir,
    dataDir: off.dataDir,
    env: {},
    denyDir: path.join(tmpDir, 'nosudo'),
    tmpDir,
  });
  writeKeysFile(off.dataDir, { subharness: { backends: [], key: null, modes: {} } });
  const refused = await refusing.runAgent({ ...AN_AGENT_RUN, cwd: off.checkout });
  assert.equal(refused.error, 'subharness-off');
  assert.deepEqual(filesUnder(tmpDir), []);
  assert.deepEqual(
    fs.readdirSync(tmpDir).filter((name) => name !== 'nosudo'),
    []
  );
});

// The run-time half of the live-checkout guard (src/development/edges.ts, docs/selfimprovement.md): setup refuses the folder
// the running engine was started from as the development checkout, and the worker refuses it again when it is built, so a
// config edited by hand cannot send the executor's branches, worktrees and test runs into the live persona's code. The
// folder is compared by real path, so a symlink does not help, and `liveDir` is the engine's own root unless a test names
// another. Temp folders only. Each test names the bug it catches.

const ENGINE_ROOT = fs.realpathSync(path.join(import.meta.dirname, '..'));

function build(checkout: string, liveDir?: string): ReturnType<typeof developmentEdges> {
  const data = tempDir('nep-live-data-');
  return developmentEdges({
    checkout,
    ...(liveDir === undefined ? {} : { liveDir }),
    privateDir: data,
    dataDir: data,
    env: { PATH: '/usr/bin:/bin' },
    denyDir: path.join(tempDir('nep-live-deny-'), 'nosudo'),
    tmpDir: os.tmpdir(),
  });
}

test('the worker refuses a checkout that is the live folder and proposes the sibling', () => {
  // Catches: a hand-edited selfimprovement.checkout aims the executor at the folder the engine reads her code from.
  const live = fs.realpathSync(tempDir('nep-live-'));
  assert.throws(
    () => build(live, live),
    (error: Error) => error.message.includes(`${live}-dev`)
  );
});

test('the worker refuses a symlink to the live folder', () => {
  // Catches: the run-time guard compares strings, and a link to the live checkout walks past it.
  const live = fs.realpathSync(tempDir('nep-live-'));
  const link = path.join(tempDir('nep-live-link-'), 'elsewhere');
  fs.symlinkSync(live, link);
  assert.throws(
    () => build(link, live),
    (error: Error) => error.message.includes(`${live}-dev`)
  );
});

test('the live folder defaults to the root of the engine that is running, so a checkout of that root is refused', () => {
  // Catches: the guard needs a setting nobody passes, and the default lets the engine's own folder through.
  assert.throws(
    () => build(ENGINE_ROOT),
    (error: Error) => error.message.includes(`${ENGINE_ROOT}-dev`)
  );
});

test('a folder beside the live one builds', () => {
  // Catches: the guard refuses the proposed sibling, or every checkout that shares a name prefix with the live folder.
  const parent = fs.realpathSync(tempDir('nep-live-parent-'));
  const live = path.join(parent, 'engine');
  const sibling = path.join(parent, 'engine-dev');
  fs.mkdirSync(live);
  fs.mkdirSync(sibling);
  assert.equal(build(sibling, live).repoDir, sibling);
});
