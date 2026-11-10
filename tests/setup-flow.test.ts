// PR 2, one setup flow and readiness: `runSetupFlow` (src/setup/flow.ts) enters at the incomplete requirement, runs only
// what is incomplete, keeps answers across a cancellation and a relaunch, and stops rather than loops on a step that did
// not help. Its internal steps are injected. The backends part is the real `subharnessStep` over fake installers and fake
// vendor CLIs: none, one, several or all, with accounts and model choices surviving a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetupFlow } from '../src/setup/flow.ts';
import type { FlowStep, SetupFlowDeps } from '../src/setup/flow.ts';
import { REQUIREMENTS } from '../src/setup/readiness.ts';
import type { ReadinessHealth, Requirement } from '../src/setup/readiness.ts';
import { subharnessStep } from '../src/setup/subharness.ts';
import type { SubharnessStepDeps } from '../src/setup/subharness.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELECTION = 'openrouter:vendor/core-1';

const HEALTHY: ReadinessHealth = {
  identity: 'ok',
  config: 'ok',
  services: 'ok',
  core: 'listening',
  link: 'authenticated',
  model: { selection: SELECTION, check: { selection: SELECTION, ok: true, code: null, at: 1 } },
  memory: { service: 'ok', writer: 'ok' },
  optional: {},
};

/** The repair of each gap this file opens: what a successful step does to the health. */
const REPAIRS: Readonly<Partial<Record<Requirement, Partial<ReadinessHealth>>>> = {
  'cli-identity': { identity: 'ok' },
  'core-running': { core: 'listening', link: 'authenticated' },
  'core-model': { model: HEALTHY.model },
};

/** A flow over a mutable health whose steps record themselves and do `outcome`, by default the repair. */
function rig(start: Partial<ReadinessHealth>, dataDir = tempDir('nep-flow-')) {
  let health: ReadinessHealth = { ...HEALTHY, ...start };
  const ran: Array<Requirement> = [];
  const outcomes: Partial<Record<Requirement, FlowStep>> = {};
  const steps = Object.fromEntries(
    REQUIREMENTS.map((requirement): [Requirement, FlowStep] => [
      requirement,
      async (context) => {
        ran.push(requirement);
        const custom = outcomes[requirement];
        if (custom !== undefined) return custom(context);
        health = { ...health, ...REPAIRS[requirement] };
        return Promise.resolve('done' as const);
      },
    ])
  ) as Record<Requirement, FlowStep>;
  const deps: SetupFlowDeps = {
    dataDir,
    health: () => Promise.resolve(health),
    steps,
    ask: () => Promise.resolve(''),
  };
  return {
    deps,
    ran,
    outcomes,
    dataDir,
    repair: (change: Partial<ReadinessHealth>) => {
      health = { ...health, ...change };
    },
  };
}

test('a ready installation runs no step at all', async () => {
  // Catches: the owner walked through a setup he finished, on every launch.
  const { deps, ran } = rig({});
  const outcome = await runSetupFlow(deps);
  assert.equal(outcome.status, 'ready');
  assert.deepEqual(ran, []);
});

test('the flow enters at the first gap, runs only the gaps, and ends ready', async () => {
  // Catches: the flow restarting at its first step, which asks every completed question again.
  const { deps, ran } = rig({
    identity: 'missing',
    core: 'down',
    link: 'untested',
    model: { selection: null, check: null },
  });
  const outcome = await runSetupFlow(deps);
  assert.equal(outcome.status, 'ready');
  assert.deepEqual(ran, ['cli-identity', 'core-running', 'core-model']);
});

test('a changed model re-enters at the model step alone', async () => {
  // Catches: readiness that sees only "setup done once", so the new model opens a chat unchecked.
  const stale = { selection: 'openrouter:vendor/core-2', check: HEALTHY.model.check };
  const { deps, ran } = rig({ model: stale });
  await runSetupFlow(deps);
  assert.deepEqual(ran, ['core-model']);
});

test('an unavailable core re-enters at the core alone, and recovery with nothing to repair runs nothing', async () => {
  // Catches: a stopped core treated as a broken install; the identity, keys and settings go through setup again.
  const { deps, ran, repair } = rig({ core: 'down', link: 'untested' });
  repair({ core: 'listening', link: 'authenticated' });
  await runSetupFlow(deps);
  assert.deepEqual(ran, []);
  repair({ core: 'down', link: 'untested' });
  await runSetupFlow(deps);
  assert.deepEqual(ran, ['core-running']);
});

test('a cancelled step stops the flow there and claims nothing', async () => {
  // Catches: cancelling reads as finished, and a chat opens over a missing model.
  const { deps, ran, outcomes } = rig({ identity: 'missing', model: { selection: null, check: null } });
  outcomes['cli-identity'] = () => Promise.resolve('cancelled');
  const outcome = await runSetupFlow(deps);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.at, 'cli-identity');
  assert.deepEqual(ran, ['cli-identity']);
});

test('answers given before a cancellation are offered again after a relaunch', async () => {
  // Catches: an interrupted setup forgets the owner's answers, and he retypes them all.
  const first = rig({ model: { selection: null, check: null } });
  first.outcomes['core-model'] = (context) => {
    context.remember('core-model.model', 'vendor/core-1');
    return Promise.resolve('cancelled');
  };
  assert.equal((await runSetupFlow(first.deps)).status, 'cancelled');
  const second = rig({ model: { selection: null, check: null } }, first.dataDir);
  let offered: string | null = null;
  second.outcomes['core-model'] = (context) => {
    offered = context.remembered('core-model.model');
    return Promise.resolve('cancelled');
  };
  await runSetupFlow(second.deps);
  assert.equal(offered, 'vendor/core-1');
});

test('a step that says done with the gap still open stops as failed, with no loop', async () => {
  // Catches: a provider that keeps refusing spins the flow forever, spending a check on each round.
  const { deps, ran, outcomes } = rig({ model: { selection: SELECTION, check: null } });
  outcomes['core-model'] = () => Promise.resolve('done');
  const outcome = await runSetupFlow(deps);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.at, 'core-model');
  assert.deepEqual(ran, ['core-model']);
});

test('a step that fails stops there with its reason, and what it broke stays reported', async () => {
  // Catches: "setup done" printed after a failed provision.
  const { deps, outcomes } = rig({ services: 'not-installed' });
  outcomes.services = () => Promise.resolve({ failed: 'daemon-reload: Failed to connect to bus' });
  const outcome = await runSetupFlow(deps);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detail, 'daemon-reload: Failed to connect to bus');
});

// The backends

/** The step's deps: the owner's `answers` in order, and the fake install. */
function stepDeps(answers: Array<string>, install: SubharnessStepDeps['install']): SubharnessStepDeps {
  return {
    ask: () => Promise.resolve(answers.shift() ?? ''),
    install,
    hostEnv: { PATH: '/usr/bin:/bin' },
    loginStdio: 'ignore',
  };
}

/** A private layer with fakes of codex and claude absent, and an install that puts in place the one npm was asked for. */
function fakes() {
  const privateDir = tempDir('nep-flow-backends-');
  writeKeysFile(privateDir, {
    subharness: { key: null, modes: { dev: 'full' }, models: { dev: 'sonnet' }, uses: { dev: 'claude' } },
  });
  const codex = fakeVendor(privateDir, 'codex', { installed: false });
  const claude = fakeVendor(privateDir, 'claude', { installed: false });
  const install: SubharnessStepDeps['install'] = (command, args, options) => {
    const vendor = args.some((one) => one.startsWith('@openai/codex')) ? codex : claude;
    return vendor.install(command, args, options);
  };
  return { privateDir, codex, claude, install };
}

test('one backend is installed through the installer and logged in, with no list stored and no role moved', async () => {
  // Catches: setup still writing the enabled list, or assigning the new backend to the agents.
  const { privateDir, codex, claude, install } = fakes();
  const deps = stepDeps(['codex'], install);
  const outcome = await subharnessStep({ privateDir }, deps);
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.equal(codex.installs.length, 1);
  assert.equal(codex.loggedIn(), true);
  assert.deepEqual(claude.installs, []);
  const stored = readKeysFile(privateDir).subharness;
  assert.equal(Object.hasOwn(stored, 'backends'), false);
  assert.deepEqual(stored.uses, { dev: 'claude' });
});

test('all is an answer of its own and needs the opencode source only when opencode is absent', async () => {
  // Catches: "all" refused as an unknown backend name.
  const { privateDir, codex, claude, install } = fakes();
  const source = path.join(tempDir('nep-flow-opencode-'), 'opencode');
  fs.writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const deps = stepDeps(['all', source, ''], install);
  await subharnessStep({ privateDir }, deps);
  assert.equal(codex.loggedIn(), true);
  assert.equal(claude.loggedIn(), true);
  assert.equal(fs.existsSync(path.join(privateDir, 'subharness', 'opencode', 'bin', 'opencode')), true);
});

test('reopening adds an omitted backend and keeps the accounts and model choices of the first', async () => {
  // Catches: the second pass logs the first account out, reinstalls it, or resets the agents' models.
  const { privateDir, codex, claude, install } = fakes();
  await subharnessStep({ privateDir }, stepDeps(['codex'], install));
  const logins = codex.calls().filter((one) => one.startsWith('login --')).length;
  const outcome = await subharnessStep({ privateDir }, stepDeps(['claude'], install));
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.equal(codex.loggedIn(), true);
  assert.equal(codex.installs.length, 1);
  assert.equal(codex.calls().filter((one) => one.startsWith('login --')).length, logins);
  assert.equal(claude.loggedIn(), true);
  assert.deepEqual(readKeysFile(privateDir).subharness.models, { dev: 'sonnet' });
});
