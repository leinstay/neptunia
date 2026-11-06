// The subscription route of her core and of the simulation (spec .agents/docs/specs/2026-11-06-core-on-subscription.md,
// "The route and where it is chosen"): `model set core|simulation <model> --via claude|codex [--effort <level>]` stores
// the record `subharness.core` or `subharness.simulation` of keys.json after one reply, `model set core <model>` and
// `model set simulation api` go back to the API, and `subharness status` names both routes. keys.json lives in a temp
// dir; the backend runner, its `--help` and fetch are fakes, so no model is asked and no request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSubscriptionPath,
  setSubscriptionPath,
  subscriptionPath,
  subscriptionPathText,
} from '../src/subharness/subscription-path.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const HELP_WITH_EFFORT = 'Usage: claude [options]\n  --model <model>\n  --effort <level>  reasoning effort\n';

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with `subharness` laid over; `installed` backends are in place and logged in, the runner answers every model but `bad-model`. */
function rig(options: { installed?: Array<'codex' | 'claude'>; subharness?: Partial<KeysFile['subharness']> } = {}) {
  const dir = tempDir('nep-subscription-path-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, models: {}, uses: {}, ...options.subharness } });
  for (const backend of options.installed ?? (['codex', 'claude'] as const))
    fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      const ok = model !== 'bad-model';
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve(HELP_WITH_EFFORT),
  };
  return { dir, deps, ran };
}

/** The line of `subharness status` that starts with two spaces and `name`. */
const lineOf = (text: string, name: string): string =>
  text.split('\n').find((line) => line.startsWith(`  ${name} `) || line.startsWith(`  ${name}\t`)) ?? '';

// the records

test('the core reads as the API route while keys.json holds no core record', () => {
  // Catches: a missing record read as an installed backend, which moves her turns onto the subscription unasked.
  const { dir } = rig();
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
});

test('a core route is stored after one reply on its model and effort', async () => {
  // Catches: the route saved without a reply, so her next turn starts a CLI that refuses the model and she falls silent.
  const { dir, deps, ran } = rig();
  const result = await setSubscriptionPath(deps, 'core', 'claude', 'claude-opus-4-6', 'low');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-4-6', effort: 'low' }]);
  assert.deepEqual(readKeysFile(dir).subharness.core, { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' });
  assert.deepEqual(subscriptionPath(dir, 'core'), {
    kind: 'subharness',
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: 'low',
  });
});

test('the simulation route is its own record and leaves the core and the memory writer where they were', async () => {
  // Catches: one shared record, so moving the simulation to codex also moves her live turns, or a write that drops the memory path.
  const memory = { backend: 'claude', model: 'claude-opus-4-6', effort: null };
  const { dir, deps } = rig({ subharness: { memory } });
  const result = await setSubscriptionPath(deps, 'simulation', 'codex', 'gpt-6.1-sol');
  assert.equal(result.ok, true);
  assert.deepEqual(subscriptionPath(dir, 'simulation'), {
    kind: 'subharness',
    backend: 'codex',
    model: 'gpt-6.1-sol',
    effort: null,
  });
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
  assert.deepEqual(readKeysFile(dir).subharness.memory, memory);
});

test('opencode is refused as a core backend before anything runs', async () => {
  // Catches: her turn sent to `opencode run`, which cannot replace its own system prompt.
  const { dir, deps, ran } = rig();
  const result = await setSubscriptionPath(deps, 'core', 'opencode', 'anthropic/claude-opus-4.6');
  assert.equal(result.code, 'backend-unsupported');
  assert.deepEqual(ran, []);
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
});

test('a backend that is not installed is refused and nothing is written', async () => {
  // Catches: a route stored on a CLI that is not there, so every turn fails with not-installed.
  const { dir, deps, ran } = rig({ installed: ['codex'] });
  const result = await setSubscriptionPath(deps, 'core', 'claude', 'claude-opus-4-6');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-installed');
  assert.deepEqual(ran, []);
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
});

test('a model whose reply fails keeps the route stored before', async () => {
  // Catches: a failed check that still overwrites the working route, and her next turn fails.
  const core = { backend: 'claude', model: 'claude-opus-4-6', effort: null };
  const { dir, deps } = rig({ subharness: { core } });
  const result = await setSubscriptionPath(deps, 'core', 'claude', 'bad-model');
  assert.equal(result.ok, false);
  assert.deepEqual(readKeysFile(dir).subharness.core, core);
});

test('a stored record naming opencode reads as the API route', () => {
  // Catches: a hand-edited record that sends her turns to a backend which cannot carry them.
  const { dir } = rig({ subharness: { core: { backend: 'opencode', model: 'x', effort: null } } });
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
});

test('clearing the core route returns it to the API and leaves the simulation route', () => {
  // Catches: the way back clearing both records, so the owner's simulation setup is lost by a core switch.
  const simulation = { backend: 'codex', model: 'gpt-6.1-sol', effort: null };
  const { dir } = rig({
    subharness: { core: { backend: 'claude', model: 'claude-opus-4-6', effort: null }, simulation },
  });
  const result = clearSubscriptionPath(dir, 'core');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
  assert.deepEqual(readKeysFile(dir).subharness.simulation, simulation);
});

test('the route in words names the backend, the model and the effort', () => {
  // Catches: a status line that hides which model her turns run on.
  const text = subscriptionPathText({ kind: 'subharness', backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  for (const word of ['codex', 'gpt-6.1-sol', 'high']) assert.ok(text.includes(word), `${word} in "${text}"`);
  assert.equal(subscriptionPathText({ kind: 'api' }), 'api');
});

// the command line and the console

test('the table parses model set simulation with --via and --effort', () => {
  // Catches: simulation refused as no model role, so the owner cannot reach its route at all.
  const parsed = parseCommandLine('/model set simulation --via codex gpt-6.1-sol --effort high');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.args, { role: 'simulation', via: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
});

/** What the core hands the console of `deps`: everything but the private directory, which the console has. */
const consoleSubharness = (deps: EnableDeps): ConsoleDeps['subharness'] => ({
  runBackend: (...args) => deps.runBackend(...args),
  fetch: (...args) => deps.fetch(...args),
  helpOf: (...args: Parameters<NonNullable<EnableDeps['helpOf']>>) => deps.helpOf!(...args),
});

/** A console over fakes: runOp records each operation, the key commands answer `keys answered`. */
function consoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const ops: Array<string> = [];
  const keysCalls: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: '', data: null });
    },
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
    keys: {
      enabled: () => true,
      run: (name) => {
        keysCalls.push(name);
        return Promise.resolve({ text: 'keys answered', status: 'ok' });
      },
    },
    ...(subharness === undefined ? {} : { subharness }),
  };
  return { desk: createConsole(deps), ops, keysCalls };
}

test('model set core with --via goes through the subharness and stores the core route', async () => {
  // Catches: --via on core refused as role-unsupported, or handed to the key commands, which check a CLI id on OpenRouter.
  const { dir, deps, ran } = rig();
  const { desk, ops, keysCalls } = consoleOver(dir, consoleSubharness(deps));
  const answer = await desk.run(
    'model.set',
    { role: 'core', via: 'claude', model: 'claude-opus-4-6', effort: 'low' },
    { id: 'owner' }
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(ops, []);
  assert.deepEqual(keysCalls, []);
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-4-6', effort: 'low' }]);
  assert.deepEqual(readKeysFile(dir).subharness.core, { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' });
});

test('model set simulation with --via stores the simulation route', async () => {
  // Catches: the simulation's --via written into the core record, which moves her live turns.
  const { dir, deps } = rig();
  const { desk } = consoleOver(dir, consoleSubharness(deps));
  const answer = await desk.run(
    'model.set',
    { role: 'simulation', via: 'codex', model: 'gpt-6.1-sol' },
    { id: 'owner' }
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(readKeysFile(dir).subharness.simulation, { backend: 'codex', model: 'gpt-6.1-sol', effort: null });
  assert.equal(readKeysFile(dir).subharness.core ?? null, null);
});

test('model set simulation api returns the simulation to the API in one command', async () => {
  // Catches: no way back for the simulation but editing keys.json by hand.
  const { dir, deps, ran } = rig({
    subharness: { simulation: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } },
  });
  const { desk, keysCalls } = consoleOver(dir, consoleSubharness(deps));
  const answer = await desk.run('model.set', { role: 'simulation', model: 'api' }, { id: 'owner' });
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(subscriptionPath(dir, 'simulation'), { kind: 'api' });
  assert.deepEqual(ran, []);
  assert.deepEqual(keysCalls, []);
});

test('model set core without --via stays with the key commands', async () => {
  // Catches: every core model set routed to the subharness, so her API model can no longer be changed.
  const { dir, deps, ran } = rig();
  const { desk, keysCalls } = consoleOver(dir, consoleSubharness(deps));
  const answer = await desk.run('model.set', { role: 'core', model: 'anthropic/claude-opus-4.6' }, { id: 'owner' });
  assert.equal(answer.text, 'keys answered');
  assert.deepEqual(keysCalls, ['model.set']);
  assert.deepEqual(ran, []);
});

/** The key commands over a store with one core key; `directPath` records the roles it is called with. */
function keysRig() {
  const privateDir = tempDir('nep-subscription-keys-');
  const store = createKeyStore({ privateDir });
  store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const { fetch } = fakeFetch(healthy);
  const direct: Array<string> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: (role) => `current/${role}`,
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
    directPath: (role) => {
      direct.push(role);
    },
  });
  return { keys, direct };
}

test('a direct model set of core returns her turns to the API route after its check', async () => {
  // Catches: "model set core <model>" saves the API model while her turns keep running through the CLI.
  const { keys, direct } = keysRig();
  const answer = await keys.run('model.set', { role: 'core', model: 'anthropic/claude-opus-4.6' }, null);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(direct, ['core']);
});

// what the owner reads

test('subharness status names the core and the simulation routes', async () => {
  // Catches: the status lists the agents and memory alone, so the owner cannot see that her turns run on a subscription.
  const { deps } = rig({ subharness: { core: { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' } } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const core = lineOf(status.text, 'core');
  for (const word of ['claude', 'claude-opus-4-6', 'low']) assert.ok(core.includes(word), `${word} on "${core}"`);
  assert.ok(lineOf(status.text, 'simulation').includes('api'), status.text);
});

test('subharness status marks a core route whose backend cannot run now', async () => {
  // Catches: a route on a logged-out CLI shown as healthy while every turn of hers fails.
  const { deps } = rig({
    installed: ['codex'],
    subharness: { core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.ok(lineOf(status.text, 'core').includes('unavailable'), status.text);
});
