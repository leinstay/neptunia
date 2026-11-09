// The real steps of the setup flow (`setupFlowSteps`, src/setup/flow.ts) walked through `runSetupFlow`, over the real
// health read (`gatherHealth`) on a temp folder. The service manager and the core's commands are fakes, so nothing
// reaches systemd or a provider. `decideLaunch` is the decision of the terminal launch in bin/neptunia.ts, which cannot be
// imported: a launch that enters the flow reads the gap with it, and after the flow it opens the chat. `prepareUnits` is
// exercised through the `services` step, which sets up an interface before the template's own step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeyStore } from '../src/keys/store.ts';
import { localConfigPath } from '../src/config/files.ts';
import { runSetupFlow, setupFlowSteps } from '../src/setup/flow.ts';
import type { RunResult } from '../src/setup/install.ts';
import { decideLaunch, evaluateReadiness, gatherHealth } from '../src/setup/readiness.ts';
import type { HealthLink } from '../src/setup/readiness.ts';
import type { SetupOptions } from '../src/setup/run.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CORE = 'neptunia-core.service';
const OK: RunResult = { code: 0, stdout: '', stderr: '' };
const SELECTION = 'openrouter:vendor/core-1';

type RigOptions = {
  /** what the owner says, by a word of the question */
  answers?: Record<string, string>;
  /** the manager's answer to a call holding this word */
  refuse?: Record<string, RunResult>;
};

function rig({ answers = {}, refuse = {} }: RigOptions = {}) {
  const base = tempDir('nep-flow-steps-');
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: ROOT,
    privateDir: path.join(base, 'data'),
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: path.join(base, 'xdg'),
  };
  const unitDir = path.join(base, 'xdg', 'systemd', 'user');
  const state = { started: false, checked: false, linkRefused: false, memory: 'ok', templateAtStart: false };
  const calls: Array<string> = [];
  const commands: Array<{ name: string; args: Record<string, unknown> }> = [];
  const run = (command: string, args: ReadonlyArray<string>): Promise<RunResult> => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    for (const [word, result] of Object.entries(refuse)) if (line.includes(word)) return Promise.resolve(result);
    if (line.includes('show-user')) return Promise.resolve({ ...OK, stdout: 'Linger=yes\n' });
    if (line.includes('is-active')) return Promise.resolve({ ...OK, code: state.started ? 0 : 3 });
    if (line.includes(`enable --now ${CORE}`)) state.started = true;
    if (line.includes('neptunia-interface@'))
      state.templateAtStart = fs.existsSync(path.join(unitDir, 'neptunia-interface@.service'));
    return Promise.resolve(OK);
  };
  const askCore = (command: { name: string; args: Record<string, unknown> }) => {
    commands.push(command);
    if (command.name === 'keys.add')
      createKeyStore({ privateDir: options.privateDir }).add({ name: String(command.args.name), value: 'value' });
    state.checked = true;
    return Promise.resolve({ status: 'ok', text: 'done' });
  };
  const link = (): Promise<HealthLink> => {
    if (!state.started) return Promise.resolve({ kind: 'down' });
    if (state.linkRefused) return Promise.resolve({ kind: 'rejected' });
    const check = state.checked ? { selection: SELECTION, ok: true, code: null, at: 1 } : null;
    const text = JSON.stringify({
      model: { selection: SELECTION, check },
      memory: { service: state.memory, writer: state.memory },
    });
    return Promise.resolve({ kind: 'up', ask: () => Promise.resolve({ status: 'ok', text }) });
  };
  const health = () => gatherHealth({ privateDir: options.privateDir, dataDir: options.dataDir, unitDir, link });
  const asked: Array<string> = [];
  const ask = (question: string, offered: string | null): Promise<string> => {
    asked.push(question);
    const found = Object.entries(answers).find(([word]) => question.includes(word));
    return Promise.resolve(found?.[1] ?? offered ?? '');
  };
  const steps = (withAsk: boolean) =>
    setupFlowSteps(options, {
      run,
      askCore,
      openChat: () => Promise.reject(new Error('the flow opens no chat of its own')),
      ...(withAsk ? { ask } : {}),
    });
  const flow = (withAsk = false) => runSetupFlow({ dataDir: options.dataDir, health, steps: steps(withAsk), ask });
  const launch = async (terminal: boolean) => decideLaunch({ terminal, readiness: evaluateReadiness(await health()) });
  return { options, unitDir, state, calls, commands, asked, health, flow, launch, run, askCore };
}

/** Brings a rig to a finished install whose core is stopped, with a checked model. */
async function installed(r: ReturnType<typeof rig>): Promise<void> {
  const outcome = await r.flow();
  assert.equal(outcome.status, 'ready', outcome.detail);
  r.state.started = false;
  r.calls.length = 0;
  r.commands.length = 0;
}

test('a terminal launch on an empty folder enters setup at the identity, and the real steps walk to the chat', async () => {
  // Catches: a step that claims done with its gap open, or an order that checks a model through a core not yet started.
  const r = rig();
  assert.deepEqual(await r.launch(true), { kind: 'setup', at: 'cli-identity' });
  const outcome = await r.flow();
  assert.deepEqual(outcome, { status: 'ready', at: null, detail: '' });
  assert.notEqual(fs.readFileSync(path.join(r.options.privateDir, 'clients', 'cli.token'), 'utf8').trim(), '');
  assert.equal(fs.existsSync(path.join(r.unitDir, CORE)), true);
  assert.equal(r.calls.filter((one) => one.includes(`enable --now ${CORE}`)).length, 1);
  assert.deepEqual(await r.launch(true), { kind: 'chat' });
});

test('with no terminal the same folder is setup-required, and nothing is provisioned', async () => {
  // Catches: the launch branch doing its work before it has asked whether anyone is there.
  const r = rig();
  const decision = await r.launch(false);
  assert.equal(decision.kind, 'setup-required');
  assert.equal(fs.existsSync(r.options.privateDir), false);
  assert.deepEqual(r.calls, []);
});

test('the first core key goes through the chat command, by the name the owner gives', async () => {
  // Catches: the flow writing a key itself, past the check the command runs on it.
  const r = rig({ answers: { 'first key': 'main-key' } });
  await r.flow();
  assert.deepEqual(r.commands, [{ name: 'keys.add', args: { name: 'main-key' } }]);
});

test('an empty name for the first core key cancels the flow where it is', async () => {
  // Catches: a key named "" sent to the core, or a cancelled question reported as a failure.
  const r = rig({ answers: { 'first key': '  ' } });
  const outcome = await r.flow();
  assert.deepEqual([outcome.status, outcome.at], ['cancelled', 'core-model']);
  assert.deepEqual(r.commands, []);
});

test('with a core key there, a blank model checks the one set and a typed one is set through its command', async () => {
  // Catches: the flow asking for a key that exists, or a blank answer saved as the model.
  const blank = rig();
  await installed(blank);
  blank.state.checked = false;
  assert.equal((await blank.flow()).status, 'ready');
  assert.deepEqual(blank.commands, [{ name: 'keys.check', args: { role: 'core' } }]);

  // Changed: the step asks for the core's route, `<key>/<model>` (spec 2026-11-09-model-routes).
  const typed = rig({ answers: { 'core route': 'vendor/core-1' } });
  await installed(typed);
  typed.state.checked = false;
  assert.equal((await typed.flow()).status, 'ready');
  assert.deepEqual(typed.commands, [{ name: 'model.set', args: { role: 'core', model: 'vendor/core-1' } }]);
});

test("a core command's refusal stops the flow with its words", async () => {
  // Catches: "setup failed" with nothing to act on, while the provider said why.
  const r = rig();
  await installed(r);
  r.state.checked = false;
  const outcome = await runSetupFlow({
    dataDir: r.options.dataDir,
    health: r.health,
    ask: () => Promise.resolve(''),
    steps: setupFlowSteps(r.options, {
      run: r.run,
      openChat: () => Promise.resolve(),
      askCore: () => Promise.resolve({ status: 'failed', text: 'the provider refused the key' }),
    }),
  });
  assert.deepEqual(outcome, { status: 'failed', at: 'core-model', detail: 'the provider refused the key' });
});

test('a stopped core is started and nothing else runs', async () => {
  // Catches: a stopped core sent through the whole install, which rewrites units and asks every question again.
  const r = rig();
  await installed(r);
  assert.equal((await r.launch(true)).kind, 'setup');
  const outcome = await r.flow();
  assert.equal(outcome.status, 'ready', outcome.detail);
  assert.equal(
    r.calls.some((one) => one.includes('daemon-reload')),
    false
  );
  assert.deepEqual(r.commands, []);
  assert.equal(r.calls.filter((one) => one.includes(`enable --now ${CORE}`)).length, 1);
});

test('a core the manager will not start fails there with the reason', async () => {
  // Catches: a flow that claims ready, or spins, over a core that never came up.
  const r = rig();
  await installed(r);
  const refused = rig({
    refuse: { 'enable --now': { code: 1, stdout: '', stderr: 'Failed to connect to bus' } },
  });
  // The same finished install on disk, under a manager that refuses.
  const outcome = await runSetupFlow({
    dataDir: r.options.dataDir,
    health: r.health,
    ask: () => Promise.resolve(''),
    steps: setupFlowSteps(r.options, { run: refused.run, askCore: r.askCore, openChat: () => Promise.resolve() }),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.at, 'core-running');
  assert.ok(outcome.detail.includes('Failed to connect to bus'), outcome.detail);
});

test('a broken local config fails with its repair and stays as it is', async () => {
  // Catches: a step that overwrites the owner's settings to get past its own gap.
  const r = rig();
  const file = localConfigPath(r.options.dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const outcome = await r.flow();
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.at, 'local-config');
  assert.notEqual(outcome.detail, '');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('a refused token and a memory that is down fail with their repairs and change nothing', async () => {
  // Catches: a token rotated behind a running unit, or a chat opened over a memory that cannot write.
  const refused = rig();
  await installed(refused);
  refused.state.started = true;
  refused.state.linkRefused = true;
  const before = fs.readFileSync(path.join(refused.options.privateDir, 'clients', 'cli.token'), 'utf8');
  const link = await refused.flow();
  assert.deepEqual([link.status, link.at], ['failed', 'cli-link']);
  assert.notEqual(link.detail, '');
  assert.equal(fs.readFileSync(path.join(refused.options.privateDir, 'clients', 'cli.token'), 'utf8'), before);

  const down = rig();
  await installed(down);
  down.state.started = true;
  down.state.memory = 'down';
  const memory = await down.flow();
  assert.deepEqual([memory.status, memory.at], ['failed', 'memory']);
  assert.notEqual(memory.detail, '');
  assert.deepEqual(down.commands, []);
});

const WITH_INTERFACE = {
  answers: { 'interface? (yes or no)': 'yes', 'bot token': 'PLATFORMTOKEN' },
};

test('an interface chosen in the flow starts after its unit template is in place', async () => {
  // Catches: `enable --now neptunia-interface@x` run before the units step, which fails on every clean install.
  const r = rig(WITH_INTERFACE);
  const outcome = await r.flow(true);
  assert.equal(outcome.status, 'ready', outcome.detail);
  assert.ok(
    r.calls.some((one) => one.includes('neptunia-interface@discord.service')),
    r.calls.join('; ')
  );
  assert.equal(r.state.templateAtStart, true);
});

test('units that cannot be prepared stop the flow at the services, and no instance is started', async () => {
  // Catches: the instance started over a template the manager never read, reported as a running interface.
  const r = rig({
    ...WITH_INTERFACE,
    refuse: { 'daemon-reload': { code: 1, stdout: '', stderr: 'Failed to connect to bus' } },
  });
  const outcome = await r.flow(true);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.at, 'services');
  assert.ok(outcome.detail.includes('Failed to connect to bus'), outcome.detail);
  assert.equal(
    r.calls.some((one) => one.includes('neptunia-interface@')),
    false
  );
});
