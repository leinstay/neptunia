// src/setup/mechanics.ts: the mechanics step of `neptunia setup` (spec 2026-11-02, "The three ticking mechanics" and
// "`selfimprovement` daily, after the watcher"). It asks on or off for `heartbeat`, `selfreflection` and
// `selfimprovement`, the hour of the daily selfimprovement wake, and refuses selfimprovement without a connected
// backend, her repository and her gh login. The terminal and gh are fakes; the private folder is a temp dir and the
// tracked layer is this checkout's. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mechanicsStep } from '../src/setup/mechanics.ts';
import type { MechanicsStepDeps } from '../src/setup/mechanics.ts';
import type { GhAnswer } from '../src/selfimprovement/repository.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const REPOSITORY = 'example/engine';

type Section = Record<string, unknown>;
type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: MechanicsStepDeps;
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
  ghFound: boolean;
};

const configFile = (privateDir: string): string => path.join(privateDir, 'config', 'config.json');
const local = (privateDir: string): Record<string, Section> =>
  JSON.parse(fs.readFileSync(configFile(privateDir), 'utf8')) as Record<string, Section>;

/** A private folder with `config` as its local config and `backends` connected in keys.json. */
function rig(
  config: Record<string, unknown> = { selfimprovement: { repository: REPOSITORY } },
  backends: Array<'codex' | 'claude' | 'opencode'> = ['codex']
): Rig {
  const privateDir = path.join(tempDir('nep-setup-mechanics-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(configFile(privateDir), JSON.stringify({ bot: { name: 'kept' }, ...config }));
  writeKeysFile(privateDir, { subharness: { backends, key: null, modes: {} } });
  const r: Rig = {
    options: { rootDir: ROOT, privateDir },
    answers: [],
    asked: [],
    ghFound: true,
    deps: {
      ask: (question, offered) => {
        r.asked.push({ question, offered });
        return Promise.resolve(r.answers.shift() ?? '');
      },
      gh: (args) => {
        if (!r.ghFound) return Promise.resolve<GhAnswer>({ found: false });
        if (args[0] === 'auth') return Promise.resolve<GhAnswer>({ found: true, code: 0, stdout: '', stderr: '' });
        const name = String(args[1]).replace(/^repos\//, '');
        return Promise.resolve<GhAnswer>({
          found: true,
          code: 0,
          stdout: JSON.stringify({ full_name: name, permissions: { push: true, pull: true } }),
          stderr: '',
        });
      },
    },
  };
  return r;
}

test('all three on with the checks passed stores each switch and the hour of the daily wake', async () => {
  // Catches: the step asks but writes nothing, or writes the hour under the old wakes group the engine no longer reads.
  const r = rig();
  r.answers = ['on', 'on', 'on', '04:30'];
  const outcome = await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.equal(outcome.state, 'done');
  assert.equal(config.heartbeat?.enabled, true);
  assert.equal(config.selfreflection?.enabled, true);
  assert.equal(config.selfimprovement?.enabled, true);
  // Changed: `selfimprovement.at` became the one setting `selfimprovement.schedule`.
  assert.equal(config.selfimprovement?.schedule, 'at 04:30');
});

test("storing the switches keeps the owner's other settings, her repository among them", async () => {
  // Catches: the step writes a fresh config.json and wipes the repository the step before it stored.
  const r = rig();
  r.answers = ['off', 'off', 'on', '03:00'];
  await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.deepEqual(config.bot, { name: 'kept' });
  assert.equal(config.selfimprovement?.repository, REPOSITORY);
});

test('off answers store false, so a tracked default of on does not win', async () => {
  // Catches: an off answer is left out of the local config, and the tracked `enabled: true` keeps the mechanic ticking.
  const r = rig();
  r.answers = ['off', 'off', 'off'];
  await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.deepEqual(
    [config.heartbeat?.enabled, config.selfreflection?.enabled, config.selfimprovement?.enabled],
    [false, false, false]
  );
});

test('each question offers the value in force, so an empty answer keeps it', async () => {
  // Catches: every question offers "on", and pressing Enter through setup switches on a mechanic the owner had off.
  const r = rig({ heartbeat: { enabled: false }, selfimprovement: { repository: REPOSITORY } });
  r.answers = ['', 'off', 'off'];
  await mechanicsStep(r.options, r.deps);
  assert.equal(r.asked[0]?.offered, 'off');
  assert.equal(local(r.options.privateDir).heartbeat?.enabled, false);
});

test('a rerun that changes nothing is already done and leaves the file as it was', async () => {
  // Catches: every rerun rewrites config.json, so the step never reports already and the live-config drift check fires.
  const r = rig({
    heartbeat: { enabled: true },
    selfreflection: { enabled: false },
    selfimprovement: { enabled: false, repository: REPOSITORY },
  });
  const before = fs.readFileSync(configFile(r.options.privateDir), 'utf8');
  r.answers = ['', '', ''];
  const outcome = await mechanicsStep(r.options, r.deps);
  assert.equal(outcome.state, 'already');
  assert.equal(fs.readFileSync(configFile(r.options.privateDir), 'utf8'), before);
});

test('an hour that is no HH:MM is asked again and the valid answer is stored', async () => {
  // Catches: "25:00" or "3am" is stored, and the daily wake never falls due or falls due at a time nobody chose.
  const r = rig();
  r.answers = ['on', 'on', 'on', '25:00', '05:15'];
  await mechanicsStep(r.options, r.deps);
  // Changed: `selfimprovement.at` became the one setting `selfimprovement.schedule`.
  assert.equal(local(r.options.privateDir).selfimprovement?.schedule, 'at 05:15');
});

test('selfimprovement on with no connected backend is refused and stored off, the other two still stored', async () => {
  // Catches: the wake turns on with no subharness to work her fixes, so every proposal she files fails subharness-off.
  const r = rig({ selfimprovement: { repository: REPOSITORY } }, []);
  r.answers = ['on', 'off', 'on', '03:00'];
  const outcome = await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.equal(outcome.state, 'refused');
  assert.equal(config.selfimprovement?.enabled, false);
  assert.deepEqual([config.heartbeat?.enabled, config.selfreflection?.enabled], [true, false]);
});

test('selfimprovement on with no repository is refused and stored off', async () => {
  // Catches: the wake runs with nowhere to open a pull request, and the first beat fails its push.
  const r = rig({});
  r.answers = ['on', 'on', 'on', '03:00'];
  const outcome = await mechanicsStep(r.options, r.deps);
  assert.equal(outcome.state, 'refused');
  assert.equal(local(r.options.privateDir).selfimprovement?.enabled, false);
});

test('selfimprovement on without gh is refused and stored off', async () => {
  // Catches: the step trusts a stored repository and turns selfimprovement on on a machine where gh is missing.
  const r = rig();
  r.ghFound = false;
  r.answers = ['on', 'on', 'on', '03:00'];
  const outcome = await mechanicsStep(r.options, r.deps);
  assert.equal(outcome.state, 'refused');
  assert.equal(local(r.options.privateDir).selfimprovement?.enabled, false);
});
