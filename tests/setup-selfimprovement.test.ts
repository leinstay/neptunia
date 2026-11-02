// The self-development step of `neptunia setup` (src/setup/selfimprovement.ts): it asks the owner for the repository her pull
// requests go to, offers the dev checkout's origin, checks through her gh login that she can push there, and stores
// `selfimprovement.repository` only when she can. The terminal, git and gh are fakes that record what they were asked; the
// private folder is a temp dir and the tracked layer is this checkout's. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selfimprovementStep } from '../src/setup/selfimprovement.ts';
import type { SelfimprovementStepDeps } from '../src/setup/selfimprovement.ts';
import type { GhAnswer } from '../src/selfimprovement/repository.ts';
import type { RunResult } from '../src/setup/run.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CHECKOUT = '/srv/dev-checkout';

type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: SelfimprovementStepDeps;
  asked: Array<{ question: string; offered: string | null }>;
  gh: Array<ReadonlyArray<string>>;
  git: Array<ReadonlyArray<string>>;
  /** what the owner types; '' takes the offered default */
  answer: string;
  origin: RunResult;
  /** the repositories her login may push to; a gh that is absent answers found: false */
  pushable: Set<string>;
  ghFound: boolean;
};

const configFile = (privateDir: string): string => path.join(privateDir, 'config.local', 'config.json');
const stored = (privateDir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(configFile(privateDir), 'utf8')) as Record<string, unknown>;

function rig(selfimprovement: Record<string, unknown> | null): Rig {
  const privateDir = path.join(tempDir('nep-setup-selfimprovement-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config.local'), { recursive: true });
  fs.writeFileSync(
    configFile(privateDir),
    JSON.stringify({ bot: { name: 'kept' }, ...(selfimprovement === null ? {} : { selfimprovement }) })
  );
  const r: Rig = {
    options: { rootDir: ROOT, privateDir },
    asked: [],
    gh: [],
    git: [],
    answer: '',
    origin: { code: 0, stdout: 'git@github.com:example/engine.git\n', stderr: '' },
    pushable: new Set(['example/engine']),
    ghFound: true,
    deps: undefined as unknown as SelfimprovementStepDeps,
  };
  r.deps = {
    run: (command, args) => {
      r.git.push([command, ...args]);
      return Promise.resolve(command === 'git' ? r.origin : { code: 1, stdout: '', stderr: 'unexpected' });
    },
    ask: (question, offered) => {
      r.asked.push({ question, offered });
      return Promise.resolve(r.answer);
    },
    gh: (args) => {
      r.gh.push(args);
      if (!r.ghFound) return Promise.resolve<GhAnswer>({ found: false });
      if (args[0] === 'auth') return Promise.resolve<GhAnswer>({ found: true, code: 0, stdout: '', stderr: '' });
      const name = String(args[1]).replace(/^repos\//, '');
      return Promise.resolve<GhAnswer>({
        found: true,
        code: 0,
        stdout: JSON.stringify({ full_name: name, permissions: { push: r.pushable.has(name), pull: true } }),
        stderr: '',
      });
    },
  };
  return r;
}

test('the step offers the dev checkout origin, takes it on an empty answer and stores it once the check passes', async () => {
  // Catches: the default is the deployed checkout's remote or the raw URL, or the repository is stored unchecked.
  const r = rig({ checkout: CHECKOUT });
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual(r.git, [['git', '-C', CHECKOUT, 'remote', 'get-url', 'origin']]);
  assert.deepEqual(
    r.asked.map((one) => one.offered),
    ['example/engine']
  );
  assert.deepEqual(r.gh.at(-1), ['api', 'repos/example/engine']);
  assert.deepEqual([outcome.state, outcome.code], ['done', 'ok']);
  assert.equal((stored(r.options.privateDir).selfimprovement as Record<string, unknown>).repository, 'example/engine');
});

test('storing the repository keeps every other key of the local config', async () => {
  // Catches: the step writes a fresh config.json with only selfimprovement.repository and wipes the owner's settings.
  const r = rig({ checkout: CHECKOUT, base: 'trunk' });
  await selfimprovementStep(r.options, r.deps);
  const config = stored(r.options.privateDir);
  assert.deepEqual(config.bot, { name: 'kept' });
  assert.deepEqual(config.selfimprovement, { checkout: CHECKOUT, base: 'trunk', repository: 'example/engine' });
});

test('a fork the owner types is checked and stored instead of the offered origin', async () => {
  // Catches: the answer is ignored and the origin is stored, so a deployment of someone else proposes upstream.
  const r = rig({ checkout: CHECKOUT });
  r.answer = '  fork-owner/engine ';
  r.pushable = new Set(['fork-owner/engine']);
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.equal(outcome.state, 'done');
  assert.deepEqual(r.gh.at(-1), ['api', 'repos/fork-owner/engine']);
  assert.equal(
    (stored(r.options.privateDir).selfimprovement as Record<string, unknown>).repository,
    'fork-owner/engine'
  );
});

test('a repository she cannot push to is refused with one line and nothing is written', async () => {
  // Catches: the refused repository is stored anyway, or the step turns self-development on with no push right.
  const r = rig({ checkout: CHECKOUT });
  r.pushable = new Set();
  const before = fs.readFileSync(configFile(r.options.privateDir), 'utf8');
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.code], ['refused', 'no-push']);
  assert.match(outcome.detail, /^[^\n]*\S[^\n]*$/);
  assert.equal(fs.readFileSync(configFile(r.options.privateDir), 'utf8'), before);
});

test('no gh on PATH refuses the step with gh-missing and writes nothing', async () => {
  // Catches: setup stores a repository the beat can never check, and every beat pauses without the owner knowing why.
  const r = rig({ checkout: CHECKOUT });
  r.ghFound = false;
  const before = fs.readFileSync(configFile(r.options.privateDir), 'utf8');
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.code], ['refused', 'gh-missing']);
  assert.equal(fs.readFileSync(configFile(r.options.privateDir), 'utf8'), before);
});

test('an origin git cannot read offers no default, and an empty answer is refused as repository-unset', async () => {
  // Catches: a failed git call offers its error text, or an empty answer stores an empty repository.
  const r = rig({ checkout: CHECKOUT });
  r.origin = { code: 2, stdout: '', stderr: "error: No such remote 'origin'" };
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual(
    r.asked.map((one) => one.offered),
    [null]
  );
  assert.deepEqual([outcome.state, outcome.code], ['refused', 'repository-unset']);
  assert.deepEqual(r.gh, []);
});

test('the step is skipped and asks nothing while selfimprovement.checkout is unset', async () => {
  // Catches: every setup asks about self-development on a deployment that has no dev checkout for it.
  const r = rig(null);
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.code], ['skipped', null]);
  assert.deepEqual([r.asked, r.gh, r.git], [[], [], []]);
});

test('a stored repository that still passes the check is already done, with no question', async () => {
  // Catches: a rerun of setup asks the owner again for a repository that works.
  const r = rig({ checkout: CHECKOUT, repository: 'fork-owner/engine' });
  r.pushable = new Set(['fork-owner/engine']);
  const outcome = await selfimprovementStep(r.options, r.deps);
  assert.deepEqual([outcome.state, outcome.code], ['already', 'ok']);
  assert.deepEqual(r.asked, []);
  assert.deepEqual(r.gh.at(-1), ['api', 'repos/fork-owner/engine']);
});
