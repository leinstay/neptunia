// src/setup/run.ts: `neptunia setup`, staged like Hermes' setup wizard (hermes_cli/setup.py: sections that run on their
// own and again; hermes_cli/setup_summary.py: a summary at the end). Five steps in a fixed order, each with a check for
// "already done", so a rerun after a failure resumes. The `run` that would call systemctl is a fake that records its
// commands; nothing touches the real systemd. Folders are temp dirs. The templates are the real deploy/ files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SETUP_STEPS, SetupUsageError, nodeOf, parseSetupArgs, runSetup } from '../src/setup/run.ts';
import type { RunResult, SetupDeps, SetupOptions } from '../src/setup/run.ts';
import { SELFDEV_UNIT_FILES, UNIT_FILES } from '../src/setup/units.ts';
import { keysPath, readKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const mode = (file: string): number => fs.statSync(file).mode & 0o777;

type Rig = {
  options: SetupOptions;
  deps: SetupDeps;
  calls: Array<Array<string>>;
  events: Array<string>;
  chat: Array<string>;
  state: { linger: boolean; active: boolean; failEnable: boolean };
  unitDir: string;
};

function rig(overrides: Partial<SetupOptions> = {}): Rig {
  const base = tempDir('nep-setup-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home,
    rootDir: ROOT,
    privateDir: path.join(base, 'private'),
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: path.join(base, 'xdg'),
    ...overrides,
  };
  const calls: Array<Array<string>> = [];
  const events: Array<string> = [];
  const chat: Array<string> = [];
  const state = { linger: false, active: false, failEnable: false };
  const unitDir =
    options.unitDir ??
    (options.system ? '/etc/systemd/system' : path.join(options.xdgConfigHome ?? '', 'systemd', 'user'));
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const deps: SetupDeps = {
    run: (command, args) => {
      const call = [command, ...args];
      calls.push(call);
      const line = call.join(' ');
      events.push(line);
      if (line.includes('daemon-reload') && !options.system)
        for (const name of UNIT_FILES) assert.ok(fs.existsSync(path.join(unitDir, name)), `${name} is written first`);
      if (line.startsWith('loginctl show-user')) return Promise.resolve(ok(`Linger=${state.linger ? 'yes' : 'no'}\n`));
      if (line.startsWith('loginctl enable-linger')) {
        state.linger = true;
        return Promise.resolve(ok());
      }
      if (line.includes('is-active')) return Promise.resolve({ code: state.active ? 0 : 3, stdout: '', stderr: '' });
      if (line.includes('enable --now')) {
        if (state.failEnable) return Promise.resolve({ code: 1, stdout: '', stderr: 'Failed to connect to bus' });
        state.active = true;
      }
      return Promise.resolve(ok());
    },
    openChat: (firstLine) => {
      events.push(`chat ${firstLine}`);
      chat.push(firstLine);
      return Promise.resolve();
    },
  };
  return { options, deps, calls, events, chat, state, unitDir };
}

test('the steps run in a fixed order: folders, keys file, units, linger, core', () => {
  // Bug: the core is started before its units exist, or the units are written before the folders they point at.
  assert.deepEqual([...SETUP_STEPS], ['folders', 'keys-file', 'units', 'linger', 'core']);
});

test('a fresh user setup creates the private folders at 0700 whatever the umask', async () => {
  // Bug: the folders take the umask (0755), so another local user reads the private layer and the memory.
  const previous = process.umask(0o022);
  try {
    const { options, deps } = rig();
    await runSetup(options, deps);
    for (const dir of [
      options.privateDir,
      path.join(options.privateDir, 'config.local'),
      path.join(options.privateDir, 'prompts.local'),
      path.join(options.privateDir, 'clients'),
      options.dataDir,
    ])
      assert.equal(mode(dir), 0o700, dir);
  } finally {
    process.umask(previous);
  }
});

test('setup writes an empty keys.json at 600 with no key in it', async () => {
  // Bug: the key store is created world-readable, or with a placeholder that the first add must work around.
  const { options, deps } = rig();
  await runSetup(options, deps);
  const file = keysPath(options.privateDir);
  assert.equal(mode(file), 0o600);
  const stored = readKeysFile(options.privateDir);
  assert.deepEqual(stored.core, []);
  assert.deepEqual(stored.extra, {});
  assert.equal(stored.subharness.backend, null);
  assert.equal(stored.simulation.key, null);
});

test('a keys.json that exists keeps its content, and a loose mode is tightened to 600', async () => {
  // Bug: a rerun of setup overwrites the owner's keys with an empty store, or leaves them readable by everyone.
  const { options, deps } = rig();
  fs.mkdirSync(options.privateDir, { recursive: true });
  const file = keysPath(options.privateDir);
  fs.writeFileSync(file, JSON.stringify({ core: [{ name: 'core-1', value: 'v' }], extra: {} }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  await runSetup(options, deps);
  assert.equal(readKeysFile(options.privateDir).core[0]?.name, 'core-1');
  assert.equal(mode(file), 0o600);
});

test('user units are written under XDG_CONFIG_HOME/systemd/user, and under home/.config when it is unset', async () => {
  // Bug: the units go to /etc or to the checkout, where the user manager does not read them.
  const withXdg = rig();
  await runSetup(withXdg.options, withXdg.deps);
  for (const name of UNIT_FILES) assert.ok(fs.existsSync(path.join(withXdg.unitDir, name)), name);
  const withoutXdg = rig({ xdgConfigHome: undefined });
  await runSetup(withoutXdg.options, withoutXdg.deps);
  for (const name of UNIT_FILES)
    assert.ok(fs.existsSync(path.join(withoutXdg.options.home, '.config', 'systemd', 'user', name)), name);
});

test('the rendered core unit names the checkout, the two directories and no User=', async () => {
  // Bug: the unit is copied as it is and points at /opt/neptunia.
  const { options, deps, unitDir } = rig();
  await runSetup(options, deps);
  const text = fs.readFileSync(path.join(unitDir, 'neptunia-core.service'), 'utf8');
  assert.ok(text.includes(`NEPTUNIA_PRIVATE_DIR=${options.privateDir}`));
  assert.ok(text.includes(`NEPTUNIA_DATA_DIR=${options.dataDir}`));
  assert.equal(/^User=/m.test(text), false);
});

test('a user setup reloads the user manager, enables linger, enables and starts the core, and uses no sudo', async () => {
  // Bug: the core dies at logout because linger is off; or systemctl runs without --user and touches the system manager.
  const { options, deps, calls } = rig();
  const report = await runSetup(options, deps);
  assert.equal(report.ok, true);
  const lines = calls.map((call) => call.join(' '));
  assert.ok(lines.includes('loginctl enable-linger alice'));
  assert.ok(lines.includes('systemctl --user daemon-reload'));
  assert.ok(lines.includes('systemctl --user enable --now neptunia-core.service'));
  assert.equal(
    calls.some((call) => call[0] === 'sudo'),
    false
  );
  assert.equal(
    calls.some((call) => call[0] === 'systemctl' && call[1] !== '--user'),
    false
  );
  assert.equal(
    lines.some((line) => /enable.*neptunia-(agent|interface|watcher)/.test(line)),
    false,
    'only the core is started by setup'
  );
});

test('setup opens the chat last, on keys core add, and only once', async () => {
  // Bug: the chat opens before the core runs, so the first line gets "no core listens".
  const { options, deps, events, chat } = rig();
  await runSetup(options, deps);
  assert.deepEqual(chat, ['/keys core add']);
  assert.equal(events[events.length - 1], 'chat /keys core add');
  const enable = events.findIndex((line) => line.includes('enable --now'));
  assert.ok(enable >= 0 && enable < events.length - 1);
});

test('the report lists every step done and the commands that come next, in the order of the guide', async () => {
  // Bug: setup ends without saying what to type next, so the owner does not know the install is only half done.
  const { options, deps } = rig();
  const report = await runSetup(options, deps);
  assert.deepEqual(
    report.steps.map((step) => [step.step, step.state]),
    SETUP_STEPS.map((step) => [step, 'done'])
  );
  assert.deepEqual(report.next, [
    'keys core add',
    'interface token set discord',
    'interface enable discord',
    'model set',
    'subharness enable',
    'simulation enable',
  ]);
});

test('a core that does not start fails the last step, stops there and opens no chat', async () => {
  // Bug: setup reports success and opens a chat on a core that never started.
  const { options, deps, state, chat } = rig();
  state.failEnable = true;
  const report = await runSetup(options, deps);
  assert.equal(report.ok, false);
  const last = report.steps.find((step) => step.step === 'core');
  assert.equal(last?.state, 'failed');
  assert.ok((last?.detail ?? '').length > 0, 'the reason is kept');
  assert.deepEqual(chat, []);
});

test('a rerun after a failure resumes: earlier steps are already done and the core is started', async () => {
  // Bug: a rerun rewrites the units and the keys file from scratch, or stops at the first step that exists.
  const { options, deps, state, chat } = rig();
  state.failEnable = true;
  await runSetup(options, deps);
  state.failEnable = false;
  const report = await runSetup(options, deps);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.steps.map((step) => [step.step, step.state]),
    [
      ['folders', 'already'],
      ['keys-file', 'already'],
      ['units', 'already'],
      ['linger', 'already'],
      ['core', 'done'],
    ]
  );
  assert.deepEqual(chat, ['/keys core add']);
});

test('a unit file edited by hand is rewritten by the next setup', async () => {
  // Bug: "already done" is decided by the file existing, so a stale unit from an older engine is never replaced.
  const { options, deps, unitDir } = rig();
  await runSetup(options, deps);
  const file = path.join(unitDir, 'neptunia-core.service');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '[Service]\nExecStart=/bin/false\n');
  const report = await runSetup(options, deps);
  assert.equal(fs.readFileSync(file, 'utf8'), good);
  assert.equal(report.steps.find((step) => step.step === 'units')?.state, 'done');
});

test('a single step runs alone and leaves the others skipped, with no command and no chat', async () => {
  // Bug: "neptunia setup folders" also starts the core (Hermes runs its sections on their own).
  const { options, deps, calls, chat } = rig({ only: 'folders' });
  const report = await runSetup(options, deps);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.steps.map((step) => [step.step, step.state]),
    [
      ['folders', 'done'],
      ['keys-file', 'skipped'],
      ['units', 'skipped'],
      ['linger', 'skipped'],
      ['core', 'skipped'],
    ]
  );
  assert.equal(fs.existsSync(keysPath(options.privateDir)), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(chat, []);
});

test('--system writes every unit through sudo install and never writes the unit folder itself', async () => {
  // Bug: --system writes to /etc without sudo and fails halfway, or runs systemctl against the user manager.
  const base = tempDir('nep-setup-sys-');
  const unitDir = path.join(base, 'etc-systemd');
  const { options, deps, calls } = rig({ system: true, unitDir });
  const installed = new Map<string, string>();
  const inner: SetupDeps['run'] = (command, args) => deps.run(command, args);
  const run: SetupDeps['run'] = (command, args) => {
    if (command === 'sudo' && args[0] === 'install') {
      const [source, target] = [args[args.length - 2] ?? '', args[args.length - 1] ?? ''];
      installed.set(target, fs.readFileSync(source, 'utf8'));
    }
    return inner(command, args);
  };
  const report = await runSetup(options, { ...deps, run });
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(unitDir), false, 'the fake /etc was only reached through sudo');
  assert.deepEqual([...installed.keys()].sort(), UNIT_FILES.map((name) => path.join(unitDir, name)).sort());
  for (const [target, text] of installed)
    if (target.endsWith('.service')) assert.ok(/^User=alice$/m.test(text), target);
  const lines = calls.map((call) => call.join(' '));
  assert.ok(lines.includes('sudo systemctl daemon-reload'));
  assert.ok(lines.includes('sudo systemctl enable --now neptunia-core.service'));
  assert.equal(
    lines.some((line) => line.includes('enable-linger')),
    false,
    'system units need no linger'
  );
  assert.equal(
    calls.some((call) => call[0] === 'systemctl'),
    false,
    'every systemctl call goes through sudo'
  );
});

test('parseSetupArgs reads --system and a step name, and refuses anything else', () => {
  // Bug: a typo such as --sytem is ignored and the units are installed as user units.
  assert.deepEqual(parseSetupArgs([]), { system: false });
  assert.deepEqual(parseSetupArgs(['--system']), { system: true });
  assert.deepEqual(parseSetupArgs(['units']), { system: false, only: 'units' });
  assert.deepEqual(parseSetupArgs(['--system', 'core']), { system: true, only: 'core' });
  for (const bad of [['--sytem'], ['bogus'], ['units', 'core']])
    assert.throws(() => parseSetupArgs(bad), SetupUsageError, bad.join(' '));
});

test('neptunia setup with an unknown option exits 2 and creates nothing', () => {
  // Bug: the entry point runs the install with whatever it was given.
  const dir = tempDir('nep-setup-bin-');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'neptunia.ts'), 'setup', '--bogus'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      NEPTUNIA_PRIVATE_DIR: path.join(dir, 'p'),
      NEPTUNIA_DATA_DIR: path.join(dir, 'd'),
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// The node path the units name (spec 2026-11-02, follow-up 6): the node setup was started with, as typed or found on
// PATH and never resolved through a link, so a symlinked /opt/node stays a link; `--node <path>` overrides it.

test('parseSetupArgs takes --node with an absolute path, beside --system and a step', () => {
  // Catches: --node is refused as an unknown option, so a deployment cannot name its node by hand.
  assert.deepEqual(parseSetupArgs(['--node', '/opt/node/bin/node']), { system: false, node: '/opt/node/bin/node' });
  assert.deepEqual(parseSetupArgs(['--system', '--node', '/usr/bin/node', 'units']), {
    system: true,
    only: 'units',
    node: '/usr/bin/node',
  });
});

test('parseSetupArgs refuses --node with no value or with a relative path', () => {
  // Catches: a relative node path lands in ExecStart, which systemd refuses, or --node swallows the step name.
  for (const bad of [['--node'], ['--node', 'bin/node'], ['--node', '--system']])
    assert.throws(() => parseSetupArgs(bad), SetupUsageError, bad.join(' '));
});

test('nodeOf finds a bare node on PATH and keeps the link folder, not its target', () => {
  // Catches: process.execPath resolves /opt/node to /opt/node-v26.1, and the next node upgrade leaves the units on the old one.
  const base = tempDir('nep-node-');
  const real = path.join(base, 'node-v26.1', 'bin');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'node'), '', { mode: 0o755 });
  fs.symlinkSync(path.join(base, 'node-v26.1'), path.join(base, 'node'));
  const linked = path.join(base, 'node', 'bin');
  const found = nodeOf({
    argv0: 'node',
    execPath: path.join(real, 'node'),
    pathEnv: [path.join(base, 'empty'), linked, '/usr/bin'].join(':'),
  });
  assert.equal(found, path.join(linked, 'node'));
});

test('nodeOf takes --node over everything, and an absolute argv0 as it is', () => {
  // Catches: the override is ignored when node is also on PATH, or an absolute argv0 is resolved.
  assert.equal(
    nodeOf({ given: '/srv/node/bin/node', argv0: '/opt/node/bin/node', execPath: '/x/node', pathEnv: '/usr/bin' }),
    '/srv/node/bin/node'
  );
  assert.equal(
    nodeOf({ argv0: '/opt/node/bin/node', execPath: '/opt/node-v26.1/bin/node', pathEnv: '' }),
    '/opt/node/bin/node'
  );
});

test('nodeOf falls back to execPath when argv0 is bare and not on PATH, or PATH is unset', () => {
  // Catches: ExecStart becomes the bare word node, which systemd does not look up.
  const empty = tempDir('nep-node-');
  assert.equal(
    nodeOf({ argv0: 'node', execPath: '/opt/node-v26.1/bin/node', pathEnv: empty }),
    '/opt/node-v26.1/bin/node'
  );
  assert.equal(
    nodeOf({ argv0: 'node', execPath: '/opt/node-v26.1/bin/node', pathEnv: undefined }),
    '/opt/node-v26.1/bin/node'
  );
});

// The selfdev units (spec 2026-11-02, follow-up 7): setup renders neptunia-selfdev.service and its timer only when
// `selfdev.checkout` names a dev checkout, so the beat never runs on the deployed checkout.

/** Writes `selfdev` into the private layer's config.local/config.json before setup runs. */
function withSelfdev(privateDir: string, selfdev: Record<string, unknown>): void {
  fs.mkdirSync(path.join(privateDir, 'config.local'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'config.local', 'config.json'), JSON.stringify({ selfdev }));
}

const unitValues = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

test('setup writes no selfdev unit while selfdev.checkout is unset', async () => {
  // Catches: the beat is installed on every deployment and works on the deployed checkout itself.
  const { options, deps, unitDir } = rig();
  await runSetup({ ...options, only: 'units' }, deps);
  for (const name of SELFDEV_UNIT_FILES) assert.equal(fs.existsSync(path.join(unitDir, name)), false, name);
});

test('setup writes the selfdev service and timer over the checkout selfdev.checkout names', async () => {
  // Catches: the selfdev service runs in the deployed checkout, or the timer starts a unit of another name.
  const { options, deps, unitDir } = rig();
  const checkout = path.join(path.dirname(options.privateDir), 'dev-checkout');
  withSelfdev(options.privateDir, { checkout });
  const report = await runSetup({ ...options, only: 'units' }, deps);
  assert.equal(report.ok, true);
  assert.deepEqual([...SELFDEV_UNIT_FILES].sort(), ['neptunia-selfdev.service', 'neptunia-selfdev.timer']);
  const service = fs.readFileSync(path.join(unitDir, 'neptunia-selfdev.service'), 'utf8');
  assert.deepEqual(unitValues(service, 'WorkingDirectory'), [checkout]);
  assert.match(unitValues(service, 'ExecStart')[0] ?? '', /^\S+ bin\/neptunia\.ts selfdev run$/);
  assert.ok(unitValues(service, 'Environment').includes(`NEPTUNIA_PRIVATE_DIR=${options.privateDir}`));
  assert.equal(service.includes('/opt/neptunia'), false);
  const timer = fs.readFileSync(path.join(unitDir, 'neptunia-selfdev.timer'), 'utf8');
  assert.deepEqual(unitValues(timer, 'Unit'), ['neptunia-selfdev.service']);
  const core = fs.readFileSync(path.join(unitDir, 'neptunia-core.service'), 'utf8');
  assert.deepEqual(unitValues(core, 'WorkingDirectory'), [options.rootDir]);
});

test('setup writes no selfdev unit when selfdev.checkout is the deployed checkout itself', async () => {
  // Catches: a checkout setting copied from the deployment makes the beat edit and push the code that is running.
  const { options, deps, unitDir } = rig();
  withSelfdev(options.privateDir, { checkout: options.rootDir });
  await runSetup({ ...options, only: 'units' }, deps);
  for (const name of SELFDEV_UNIT_FILES) assert.equal(fs.existsSync(path.join(unitDir, name)), false, name);
});
