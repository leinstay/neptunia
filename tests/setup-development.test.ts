// The development step of `neptunia setup` (src/setup/development.ts, docs/selfimprovement.md): a person gives a repository
// they can push to and a folder, and setup does the rest in four steps. First gh (installed through the official route
// when it can be, otherwise the step stops and says what to install). Then access (`gh auth status` and the push right on the
// repository). Then the folder (an empty one is cloned and `npm install` runs in the checkout and every `interfaces/<name>/`,
// a checkout of the same repository is only verified, any other content is refused). Last the live-checkout guard (the folder
// the running engine was started from is never the development checkout, even through a symlink). The terminal, gh, git and
// npm are fakes that record what they were asked; the fake clone writes a small checkout to disk. No network, no sudo.
// Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { developmentSetup } from '../src/setup/development.ts';
import type { DevelopmentSetupDeps, GhInstall } from '../src/setup/development.ts';
import type { GhAnswer } from '../src/selfimprovement/repository.ts';
import type { RunResult } from '../src/setup/install.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The running engine of these tests: setup compares the folder with `options.rootDir`. */
const LIVE = fs.realpathSync(path.join(import.meta.dirname, '..'));

type Call = { command: string; args: ReadonlyArray<string>; cwd: string | null };
type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: DevelopmentSetupDeps;
  /** every command `run` was given, in order */
  calls: Array<Call>;
  /** every gh command of the GhRunner, in order */
  gh: Array<ReadonlyArray<string>>;
  asked: Array<string>;
  /** what the person types, first the repository then the folder; a missing answer is empty */
  answers: Array<string>;
  installs: number;
  /** what installGh answers; `installed` also puts gh on the fake PATH */
  install: GhInstall;
  ghFound: boolean;
  loggedIn: boolean;
  /** the repositories the login may push to */
  pushable: Set<string>;
  /** the `origin` URL git reports for a folder */
  origins: Map<string, string>;
};

const ok: RunResult = { code: 0, stdout: '', stderr: '' };
const configFile = (privateDir: string): string => path.join(privateDir, 'config', 'config.json');
const configText = (r: Rig): string => fs.readFileSync(configFile(r.options.privateDir), 'utf8');
const stored = (r: Rig): Record<string, unknown> =>
  (JSON.parse(configText(r)) as Record<string, unknown>).selfimprovement as Record<string, unknown>;

/** What a fresh clone of the engine holds, as far as setup cares: a git folder, packages and one plain file. */
function writeCheckout(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(dir, 'interfaces', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'interfaces', name, 'package.json'), '{}');
  }
  fs.writeFileSync(path.join(dir, 'interfaces', 'notes.md'), 'not a package\n');
}

/** Every file and folder under `dir`, as paths from it. */
const treeOf = (dir: string): Array<string> => fs.readdirSync(dir, { recursive: true }).map(String).sort();

function rig(selfimprovement: Record<string, unknown> | null = null): Rig {
  const privateDir = path.join(tempDir('nep-setup-development-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(
    configFile(privateDir),
    JSON.stringify({ bot: { name: 'kept' }, ...(selfimprovement === null ? {} : { selfimprovement }) })
  );
  const r: Rig = {
    options: { rootDir: LIVE, privateDir },
    calls: [],
    gh: [],
    asked: [],
    answers: [],
    installs: 0,
    install: { code: 'installed' },
    ghFound: true,
    loggedIn: true,
    pushable: new Set(['example/engine']),
    origins: new Map(),
    deps: undefined as unknown as DevelopmentSetupDeps,
  };
  r.deps = {
    run: (command, args, options) => {
      r.calls.push({ command, args: [...args], cwd: options?.cwd ?? null });
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
        const dest = String(args[3]);
        writeCheckout(dest);
        r.origins.set(dest, `https://github.com/${String(args[2])}.git`);
        return Promise.resolve(ok);
      }
      if (command === 'git' && args.includes('get-url')) {
        const dir = args[0] === '-C' ? String(args[1]) : (options?.cwd ?? '');
        const origin = r.origins.get(dir);
        return Promise.resolve(
          origin === undefined
            ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
            : { code: 0, stdout: `${origin}\n`, stderr: '' }
        );
      }
      if (command === 'npm') return Promise.resolve(ok);
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
    },
    ask: (question) => {
      r.asked.push(question);
      return Promise.resolve(r.answers.shift() ?? '');
    },
    gh: (args) => {
      r.gh.push(args);
      if (!r.ghFound) return Promise.resolve<GhAnswer>({ found: false });
      if (args[0] === 'auth')
        return Promise.resolve<GhAnswer>({ found: true, code: r.loggedIn ? 0 : 1, stdout: '', stderr: '' });
      const name = String(args[1]).replace(/^repos\//, '');
      return Promise.resolve<GhAnswer>({
        found: true,
        code: 0,
        stdout: JSON.stringify({ full_name: name, permissions: { push: r.pushable.has(name), pull: true } }),
        stderr: '',
      });
    },
    installGh: () => {
      r.installs += 1;
      if (r.install.code === 'installed') r.ghFound = true;
      return Promise.resolve(r.install);
    },
  };
  return r;
}

const cloned = (r: Rig): Array<Call> => r.calls.filter((c) => c.command === 'gh' && c.args[1] === 'clone');
const installed = (r: Rig): Array<Call> => r.calls.filter((c) => c.command === 'npm');

test('an empty folder is cloned with gh repo clone and npm installs in the checkout and in every interface package', async () => {
  // Catches: the clone lands but the executor's tests cannot run, because only the root or only one package got its modules.
  const r = rig();
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  fs.mkdirSync(folder);
  r.answers = ['example/engine', folder];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['done', 'folder']);
  assert.deepEqual(
    cloned(r).map((c) => [c.command, ...c.args]),
    [['gh', 'repo', 'clone', 'example/engine', folder]]
  );
  assert.deepEqual(
    installed(r)
      .map((c) => c.cwd)
      .sort(),
    [folder, path.join(folder, 'interfaces', 'alpha'), path.join(folder, 'interfaces', 'beta')]
  );
  assert.ok(installed(r).every((c) => c.args[0] === 'install'));
});

test('a folder that does not exist yet is cloned into as well', async () => {
  // Catches: setup insists on a pre-made folder, so the person is told to mkdir before the one thing setup should do.
  const r = rig();
  const folder = path.join(tempDir('nep-dev-folder-'), 'not-made-yet');
  r.answers = ['example/engine', folder];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.equal(outcome.state, 'done');
  assert.equal(cloned(r).length, 1);
  assert.equal(installed(r).length, 3);
});

test('a finished step stores the repository and the folder and keeps every other key of the local config', async () => {
  // Catches: the two inputs are not written, so the executor starts without a checkout, or the owner's other settings are wiped.
  const r = rig({ base: 'trunk' });
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  r.answers = ['example/engine', folder];
  await developmentSetup(r.options, r.deps);
  const config = JSON.parse(configText(r)) as Record<string, unknown>;
  assert.deepEqual(config.bot, { name: 'kept' });
  assert.deepEqual(config.selfimprovement, { base: 'trunk', repository: 'example/engine', checkout: folder });
});

test('the two inputs are asked in order, repository then folder, and a stored one is not asked again', async () => {
  // Catches: a rerun, or a person who already set one key by hand, is asked for a value the config holds.
  const r = rig({ repository: 'example/engine' });
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  r.answers = [folder];
  await developmentSetup(r.options, r.deps);
  assert.equal(r.asked.length, 1);
  assert.equal(cloned(r)[0]?.args[3], folder);
});

test('a missing gh is installed through the installer, and the later steps then run with it', async () => {
  // Catches: setup stops on a machine where gh could have been installed, or goes on and fails with a spawn error.
  const r = rig();
  r.ghFound = false;
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  r.answers = ['example/engine', folder];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.equal(r.installs, 1);
  assert.equal(outcome.state, 'done');
  assert.equal(cloned(r).length, 1);
});

test('a gh that cannot be installed stops at the gh step, prints what to install, and asks and clones nothing', async () => {
  // Catches: the step goes on without gh and fails later with a message about something else, or a clone is tried blind.
  const r = rig();
  r.ghFound = false;
  r.install = { code: 'manual', what: 'Install the GitHub CLI from https://cli.github.com and run setup again.' };
  const before = configText(r);
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'gh']);
  assert.match(outcome.detail, /Install the GitHub CLI from https:\/\/cli\.github\.com/);
  assert.deepEqual([r.asked, r.calls], [[], []]);
  assert.equal(configText(r), before);
});

test('a gh that is present is not installed again', async () => {
  // Catches: every setup run reinstalls gh, which asks for root on a machine that already has it.
  const r = rig();
  r.answers = ['example/engine', path.join(tempDir('nep-dev-folder-'), 'engine-dev')];
  await developmentSetup(r.options, r.deps);
  assert.equal(r.installs, 0);
});

test('a gh that is logged out is refused at the access step before any push check or clone', async () => {
  // Catches: setup clones with a login that cannot authenticate, or reports a push failure instead of the login.
  const r = rig();
  r.loggedIn = false;
  r.answers = ['example/engine', path.join(tempDir('nep-dev-folder-'), 'engine-dev')];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'access']);
  assert.match(outcome.detail, /gh auth login/);
  assert.deepEqual(r.gh, [['auth', 'status']]);
  assert.deepEqual(cloned(r), []);
});

test('a repository without push access is refused naming the fork, and nothing is cloned or written', async () => {
  // Catches: development turned on against an upstream the login cannot push to, so every pull request fails at the last step.
  const r = rig();
  r.pushable = new Set();
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  r.answers = ['upstream/engine', folder];
  const before = configText(r);
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'access']);
  assert.match(outcome.detail, /upstream\/engine/);
  assert.match(outcome.detail, /fork/i);
  assert.deepEqual(r.gh.at(-1), ['api', 'repos/upstream/engine']);
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(configText(r), before);
});

test('an existing checkout of the same repository downloads nothing, installs nothing, and only verifies', async () => {
  // Catches: a second setup clones over, or reinstalls the modules of, a checkout the person already works in.
  const r = rig();
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  writeCheckout(folder);
  r.origins.set(folder, 'git@github.com:example/engine.git');
  r.answers = ['example/engine', folder];
  const tree = treeOf(folder);
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['done', 'folder']);
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
  assert.ok(r.calls.some((c) => c.command === 'git' && c.args.includes('get-url')));
  assert.deepEqual(r.gh.at(-1), ['api', 'repos/example/engine']);
  assert.deepEqual(treeOf(folder), tree);
  assert.equal(stored(r).checkout, folder);
});

test('a folder holding another repository is refused naming it, and nothing is cloned or written', async () => {
  // Catches: the executor later creates branches and worktrees in a project that is not the engine.
  const r = rig();
  const folder = path.join(tempDir('nep-dev-folder-'), 'other');
  writeCheckout(folder);
  r.origins.set(folder, 'https://github.com/someone/other-project.git');
  r.answers = ['example/engine', folder];
  const before = configText(r);
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'folder']);
  assert.match(outcome.detail, /someone\/other-project/);
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
  assert.equal(configText(r), before);
});

test('a non-empty folder that is no git checkout is refused and left as it is', async () => {
  // Catches: gh repo clone fails halfway into a folder holding someone's files, or setup writes among them.
  const r = rig();
  const folder = tempDir('nep-dev-folder-');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine\n');
  r.answers = ['example/engine', folder];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'folder']);
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
  assert.deepEqual(treeOf(folder), ['notes.txt']);
});

test('a relative folder is refused, because the units need an absolute path', async () => {
  // Catches: a relative answer is cloned into the working directory of setup and stored as a path the unit cannot use.
  const r = rig();
  r.answers = ['example/engine', 'engine-dev'];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'folder']);
  assert.deepEqual(cloned(r), []);
});

test('the folder the engine runs from is refused with a sibling proposal, even when it is a checkout of the right repository', async () => {
  // Catches: the executor's branches and test runs happen in the folder the live persona reads her code from.
  const r = rig();
  r.origins.set(LIVE, 'https://github.com/example/engine.git');
  r.answers = ['example/engine', LIVE];
  const before = configText(r);
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'guard']);
  assert.ok(outcome.detail.includes(`${LIVE}-dev`));
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
  assert.equal(configText(r), before);
});

test('a symlink to the folder the engine runs from is refused as that folder, and the proposal is built from the real path', async () => {
  // Catches: the guard compares strings, and a link to the live checkout walks past it.
  const r = rig();
  const link = path.join(tempDir('nep-dev-link-'), 'looks-elsewhere');
  fs.symlinkSync(LIVE, link);
  r.origins.set(link, 'https://github.com/example/engine.git');
  r.answers = ['example/engine', link];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.step], ['refused', 'guard']);
  assert.ok(outcome.detail.includes(`${LIVE}-dev`));
  assert.deepEqual([cloned(r), installed(r)], [[], []]);
});

test('a folder beside the live one passes the guard', async () => {
  // Catches: a guard so wide that the proposed sibling, or any folder with a shared prefix, is refused too.
  const r = rig();
  const parent = tempDir('nep-dev-parent-');
  const live = path.join(parent, 'live');
  // A stand-in for the live folder that holds the tracked layer setup reads.
  fs.cpSync(path.join(LIVE, 'config'), path.join(live, 'config'), { recursive: true });
  r.options = { ...r.options, rootDir: live };
  r.answers = ['example/engine', `${live}-dev`];
  const outcome = await developmentSetup(r.options, r.deps);
  assert.equal(outcome.state, 'done');
  assert.equal(cloned(r)[0]?.args[3], `${live}-dev`);
});

test('a repeat run with the same inputs changes nothing: no question, no clone, no install, same files, same config', async () => {
  // Catches: setup is not safe to run again, so a person who reruns it after a failure loses or duplicates work.
  const r = rig();
  const folder = path.join(tempDir('nep-dev-folder-'), 'engine-dev');
  r.answers = ['example/engine', folder];
  await developmentSetup(r.options, r.deps);
  const [config, tree, asked, clones, npm] = [
    configText(r),
    treeOf(folder),
    r.asked.length,
    cloned(r).length,
    installed(r).length,
  ];
  const again = await developmentSetup(r.options, r.deps);
  assert.deepEqual([again.state, again.step], ['already', 'folder']);
  assert.equal(r.asked.length, asked);
  assert.equal(cloned(r).length, clones);
  assert.equal(installed(r).length, npm);
  assert.deepEqual(treeOf(folder), tree);
  assert.equal(configText(r), config);
});
