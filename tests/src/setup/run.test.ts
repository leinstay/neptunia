// src/setup/run.ts: `neptunia setup`, in sections that run on their own and again, with a summary at the end. Steps in a fixed order, each with a check for
// "already done", so a rerun after a failure resumes. The `run` that would call systemctl is a fake that records its
// commands; nothing touches the real systemd. Folders are temp dirs. The templates are the real deploy/ files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { SETUP_STEPS, SetupUsageError, nodeOf, parseSetupArgs, runSetup } from '../../../src/setup/run.ts';
import type { RunResult, SetupDeps, SetupOptions } from '../../../src/setup/run.ts';
import { UNIT_FILES } from '../../../src/setup/units.ts';
import { parseCommandLine } from '../../../src/interface/commands/table.ts';
import { keysPath, readKeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES } from '../../../bin/neptunia-request.ts';
import type { Parsed } from '../../../src/interface/commands/table.ts';
import { loadPrincipals } from '../../../src/interface/principals.ts';
import { coreSocketPath } from '../../../src/interface/socket.ts';
import { addClient } from '../../../src/setup/clients.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
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
    // Runtime setup has one persona root; privateDir is its internal alias.
    privateDir: path.join(base, 'data'),
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

test('a fresh user setup creates the private folders at 0700 whatever the umask', async () => {
  // Bug: the folders take the umask (0755), so another local user reads the private layer and the memory.
  const previous = process.umask(0o022);
  try {
    const { options, deps } = rig();
    await runSetup(options, deps);
    for (const dir of [
      options.privateDir,
      path.join(options.privateDir, 'config'),
      path.join(options.privateDir, 'prompts'),
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
  // Availability is install and login, so a store holds no list of backends.
  assert.equal(Object.hasOwn(stored.subharness, 'backends'), false);
});

test('a keys.json that exists keeps its content, and a loose mode is tightened to 600', async () => {
  // Bug: a rerun of setup overwrites the owner's keys with an empty store, or leaves them readable by everyone.
  const { options, deps } = rig();
  fs.mkdirSync(options.privateDir, { recursive: true });
  const file = keysPath(options.privateDir);
  // keys.json holds named keys under `keys`.
  fs.writeFileSync(file, JSON.stringify({ keys: { 'core-1': 'v' } }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  await runSetup(options, deps);
  assert.deepEqual(Object.keys(readKeysFile(options.privateDir).extra), ['core-1']);
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
    lines.some((line) => /enable.*neptunia-(agent|interface)/.test(line)),
    false,
    'only the core is started by setup'
  );
});

test('setup opens the chat last, on keys core add, and only once', async () => {
  // Bug: the chat opens before the core runs, so the first line gets "no core listens".
  const { options, deps, events, chat } = rig();
  await runSetup(options, deps);
  assert.deepEqual(chat, ['/keys add']);
  assert.equal(events[events.length - 1], 'chat /keys add');
  const enable = events.findIndex((line) => line.includes('enable --now'));
  assert.ok(enable >= 0 && enable < events.length - 1);
});

test('the report lists every step done and the commands that come next, in the order of the guide', async () => {
  // Bug: setup ends without saying what to type next, so the owner does not know the install is only half done.
  const { options, deps } = rig();
  const report = await runSetup(options, deps);
  // The steps that ask are skipped in this rig (no terminal), every other step is done.
  const asking = ['interfaces', 'services', 'subharness', 'mechanics'];
  assert.deepEqual(
    report.steps.map((entry) => [entry.step, entry.state]),
    SETUP_STEPS.map((step) => [step, asking.includes(step) ? 'skipped' : 'done'])
  );
  // Every line is one the table accepts once its placeholders are filled: the token through the interface's own
  // setting, the core's model as a route, and the interface before its command.
  assert.deepEqual(report.next, [
    'keys add <name>',
    'interfaces discord set token',
    'interfaces discord enable',
    'model set core <name>/<model>',
    'subharness claude login',
  ]);
});

test('every command setup names next parses in the chat once its placeholders are filled', async () => {
  // Catches: setup ending on a command the table refuses, so the owner's first line is an error.
  const { options, deps } = rig();
  const report = await runSetup(options, deps);
  for (const line of report.next) {
    const filled = `/${line.replace('<name>/<model>', 'main/vendor/model').replace('<name>', 'main')}`;
    const parsed = parseCommandLine(filled);
    assert.equal(parsed.ok, true, `${filled}: ${parsed.ok ? '' : parsed.reason}`);
  }
});

test('a core that does not start fails the last step, stops there and opens no chat', async () => {
  // Bug: setup reports success and opens a chat on a core that never started.
  const { options, deps, state, chat } = rig();
  state.failEnable = true;
  const report = await runSetup(options, deps);
  assert.equal(report.ok, false);
  const last = report.steps.find((entry) => entry.step === 'core');
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
    report.steps.map((entry) => [entry.step, entry.state]),
    // The four steps that ask run before the units, skipped in this rig (no ask).
    [
      ['folders', 'already'],
      ['keys-file', 'already'],
      // The interfaces step sits after the key file, and asks.
      ['interfaces', 'skipped'],
      ['services', 'skipped'],
      ['subharness', 'skipped'],
      ['mechanics', 'skipped'],
      ['units', 'already'],
      ['linger', 'already'],
      ['core', 'done'],
    ]
  );
  assert.deepEqual(chat, ['/keys add']);
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
  assert.equal(report.steps.find((entry) => entry.step === 'units')?.state, 'done');
});

test('a single step runs alone and leaves the others skipped, with no command and no chat', async () => {
  // Bug: "neptunia setup folders" also starts the core (the sections run on their own).
  const { options, deps, calls, chat } = rig({ only: 'folders' });
  const report = await runSetup(options, deps);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.steps.map((entry) => [entry.step, entry.state]),
    // The four steps that ask run before the units, skipped as not asked for.
    [
      ['folders', 'done'],
      ['keys-file', 'skipped'],
      // The interfaces step sits after the key file.
      ['interfaces', 'skipped'],
      ['services', 'skipped'],
      ['subharness', 'skipped'],
      ['mechanics', 'skipped'],
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

test('parseSetupArgs reads --system, and refuses anything else', () => {
  // Bug: a typo such as --sytem is ignored and the units are installed as user units.
  assert.deepEqual(parseSetupArgs([]), { system: false });
  assert.deepEqual(parseSetupArgs(['--system']), { system: true });
  // The step words are no public command, so only the flags parse.
  for (const bad of [['--sytem'], ['bogus'], ['units', 'core']])
    assert.throws(() => parseSetupArgs(bad), SetupUsageError, bad.join(' '));
});

// The node path the units name: the node setup was started with, as typed or found on
// PATH and never resolved through a link, so a symlinked /opt/node stays a link; `--node <path>` overrides it.

test('parseSetupArgs takes --node with an absolute path, beside --system', () => {
  // Catches: --node is refused as an unknown option, so a deployment cannot name its node by hand.
  assert.deepEqual(parseSetupArgs(['--node', '/opt/node/bin/node']), { system: false, node: '/opt/node/bin/node' });
  // The step words are no public command.
  assert.deepEqual(parseSetupArgs(['--system', '--node', '/usr/bin/node']), { system: true, node: '/usr/bin/node' });
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

// The subharness and mechanics steps, asked before the units are written, so the units bind the backends just connected.

test('the questions of the subharness and the mechanics come before the units, and the core comes last', () => {
  // Catches: the backends are asked after the units were rendered, so the agent units carry the old values until a
  // second setup run.
  const at = (step: string): number => SETUP_STEPS.findIndex((one) => one === step);
  for (const step of ['subharness', 'mechanics']) {
    assert.notEqual(at(step), -1, step);
    assert.ok(at(step) < at('units'), step);
  }
  assert.equal(SETUP_STEPS.at(-1), 'core');
});

test('without a terminal the subharness and mechanics steps are skipped and the install still opens the chat', async () => {
  // Catches: a setup run by a script with no terminal fails on a question nobody can answer and never starts the core.
  const { options, deps, chat } = rig();
  const report = await runSetup(options, deps);
  const stateOf = (step: string): string | undefined => report.steps.find((one) => one.step === step)?.state;
  assert.deepEqual(['subharness', 'mechanics'].map(stateOf), ['skipped', 'skipped']);
  assert.equal(report.ok, true);
  assert.deepEqual(chat, ['/keys add']);
});

// What setup provisions with no core socket: `runSetup` writes the identity of the command line, and the step words of
// the public command are refused.

const OK: RunResult = { code: 0, stdout: '', stderr: '' };

function setupOptions(): SetupOptions {
  const base = tempDir('nep-provision-');
  return {
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
}

const runSetupFully = (options: SetupOptions) =>
  runSetup(options, {
    run: (_command, args) => Promise.resolve(args.includes('is-active') ? { code: 3, stdout: '', stderr: '' } : OK),
    openChat: () => Promise.resolve(),
  });

test('setup provisions the CLI identity with no core socket', async () => {
  // Catches: the first chat dies on "cannot read the token" because no step ever wrote one.
  const options = setupOptions();
  const report = await runSetupFully(options);
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(coreSocketPath(options.dataDir)), false);
  const cli = (loadPrincipals(options.privateDir) ?? []).find((one) => one.name === 'cli');
  assert.equal(cli?.kind, 'cli');
  const file = path.join(options.privateDir, 'clients', 'cli.token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(file, 'utf8').trim(), '');
});

test('a second setup keeps the CLI token', async () => {
  // Catches: repeating setup rotates the token under a running chat.
  const options = setupOptions();
  await runSetupFully(options);
  const file = path.join(options.privateDir, 'clients', 'cli.token');
  const token = fs.readFileSync(file, 'utf8');
  await runSetupFully(options);
  assert.equal(fs.readFileSync(file, 'utf8'), token);
});

test('every step word of neptunia setup is refused and names the single flow, while the steps stay internal', () => {
  // Catches: a step subcommand left public; `setup units` and friends bypass the readiness the flow is built on.
  assert.ok(SETUP_STEPS.includes('units'), 'the implementation keeps its steps');
  for (const step of SETUP_STEPS) {
    assert.throws(
      () => parseSetupArgs([step]),
      (error: unknown) => error instanceof SetupUsageError && error.message.includes('neptunia setup'),
      step
    );
  }
});

// The server unit as `neptunia setup` writes it: setup hands the renderer the names of the clients and interfaces the
// install has, so the unit on disk hides each token and each `credentials.json`.

/** The units under test and the client each one connects as. */
const AGENT_UNITS = [{ file: 'neptunia-agent-server.service' }] as const;

/** Every path any `InaccessiblePaths=` line names, with the `-` that lets it be missing kept. */
const hiddenOf = (text: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('InaccessiblePaths='))
    .flatMap((line) => line.slice('InaccessiblePaths='.length).split(/\s+/))
    .filter((one) => one !== '');

// ---------- the same lines, through `neptunia setup` ----------

/** One setup rig with a Discord interface folder and an interface client. */
function secretsRig() {
  const base = tempDir('nep-agent-secrets-');
  const dataDir = path.join(base, 'data');
  const xdg = path.join(base, 'xdg');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config', 'config.json'), JSON.stringify({}));
  fs.mkdirSync(path.join(dataDir, 'interfaces', 'discord'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'interfaces', 'discord', 'credentials.json'), '{"token":"x"}\n');
  fs.mkdirSync(path.join(dataDir, 'clients'), { recursive: true });
  // An interface client whose folder does not exist yet: its token is still another client's.
  addClient(dataDir, 'matrix', { kind: 'interface', iface: 'matrix', permissions: [] });
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: ROOT,
    privateDir: dataDir,
    dataDir,
    node: '/usr/bin/node',
    xdgConfigHome: xdg,
    only: 'units',
  };
  const deps: SetupDeps = {
    run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    openChat: () => Promise.resolve(),
  };
  const rendered = (file: string): string => fs.readFileSync(path.join(xdg, 'systemd', 'user', file), 'utf8');
  return { options, deps, dataDir, rendered };
}

test('setup writes the server unit with the clients and interfaces the install has', async () => {
  // Bug: the generator can hide paths, but setup never hands it the names, so the units on disk keep the hole.
  const { options, deps, dataDir, rendered } = secretsRig();
  await runSetup(options, deps);
  for (const { file } of AGENT_UNITS) {
    const hidden = hiddenOf(rendered(file));
    // cli is made by this very step, so it is hidden on the first render, not the second.
    // The server unit keeps no token of its own.
    for (const other of ['cli', 'matrix']) {
      assert.ok(hidden.includes(`-${path.join(dataDir, 'clients', `${other}.token`)}`), `${file}: ${other}`);
    }
    assert.ok(hidden.includes(`-${path.join(dataDir, 'interfaces', 'discord', 'credentials.json')}`), file);
    assert.ok(hidden.includes(`-${path.join(dataDir, 'interfaces', 'matrix', 'credentials.json')}`), file);
  }
});

// The commands the report of `neptunia setup` says to type next.

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** The parse of a line, which must have stood. */
function assertParsed(line: string): Extract<Parsed, { ok: true }> {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed;
}

test('the commands setup says to type next begin with a command of the table', async () => {
  // Catches: the guide's last lines send the owner to a command that was renamed.
  const base = tempDir('nep-naming-setup-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home,
    rootDir: REPO,
    privateDir: path.join(base, 'data'),
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: path.join(base, 'xdg'),
  };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const state = { linger: false, active: false };
  const deps: SetupDeps = {
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      if (line.startsWith('loginctl show-user')) return Promise.resolve(ok(`Linger=${state.linger ? 'yes' : 'no'}\n`));
      if (line.startsWith('loginctl enable-linger')) state.linger = true;
      if (line.includes('is-active')) return Promise.resolve({ code: state.active ? 0 : 3, stdout: '', stderr: '' });
      if (line.includes('enable --now')) state.active = true;
      return Promise.resolve(ok());
    },
    openChat: () => Promise.resolve(),
  };
  const report = await runSetup(options, deps);
  assert.ok(report.next.length > 0);
  for (const entry of report.next) {
    assert.ok(COMMAND_NAMES.includes(entry.split(' ')[0] ?? ''), entry);
    if (entry.includes('discord')) assertParsed(`/${entry}`);
  }
});
