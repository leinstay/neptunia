// src/setup/units.ts: the unit templates of deploy/ rendered for the installing user, as user units (no User=, default
// target) or as system units (User= the installing user). The templates are the real files of deploy/, so a template
// edit the renderer does not know fails here. Only the lines of a unit that matter are read; comments are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNIT_FILES, renderUnit } from '../../../src/setup/units.ts';
import type { UnitVars } from '../../../src/setup/units.ts';
import { installUnits } from '../../../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../../../src/setup/install.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import os from 'node:os';
import { createInstalledBackend } from '../../../src/agent-runner/backend.ts';

const DEPLOY = path.join(import.meta.dirname, '..', '..', '..', 'deploy');

const VARS: UnitVars = {
  user: 'alice',
  group: 'alice',
  home: '/home/alice',
  rootDir: '/srv/engine',
  // UnitVars retains privateDir as an alias of the canonical data root.
  privateDir: '/srv/engine-data',
  dataDir: '/srv/engine-data',
  node: '/home/alice/.nvm/bin/node',
};

const template = (name: string): string => fs.readFileSync(path.join(DEPLOY, name), 'utf8');

/** The lines of a rendered unit that are not comments or blank. */
const linesOf = (text: string): Array<string> =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith(';'));

const valuesOf = (text: string, key: string): Array<string> =>
  linesOf(text)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

// Each agent has a unit of its own name.
const AGENTS = ['neptunia-agent-server.service', 'neptunia-agent-scout.service', 'neptunia-agent-code.service'];

for (const field of ['rootDir', 'privateDir', 'dataDir'] as const) {
  test(`rendering preserves ${field} when its replacement contains a legacy home prefix`, () => {
    // Catches replacement values being rewritten as though they were still template paths.
    const selected = `/home/neptunia/worktree/${field}`;
    const vars: UnitVars = {
      ...VARS,
      home: '/home/installer',
      [field]: selected,
      ...(field === 'privateDir' ? { dataDir: selected } : {}),
    };
    const text = renderUnit(template('neptunia-core.service'), 'user', vars);
    assert.deepEqual(valuesOf(text, 'WorkingDirectory'), [vars.rootDir]);
    const env = valuesOf(text, 'Environment');
    assert.ok(env.includes(`NEPTUNIA_DATA_DIR=${vars.dataDir}`));
    const dirs = (env.find((value) => value.startsWith('PATH=')) ?? '').slice(5).split(':');
    assert.ok(dirs.includes(`${vars.home}/.local/bin`));
  });
}

for (const scope of ['user', 'system'] as const) {
  test(`${scope} units keep nothing of the old layout: no /opt path, no service users, no bot unit`, () => {
    // Bug: a path or user of the old multi-user layout survives, and the unit starts nothing on this machine.
    for (const name of UNIT_FILES) {
      const text = linesOf(renderUnit(template(name), scope, VARS)).join('\n');
      for (const old of [
        '/opt/neptunia',
        '/opt/node',
        '/usr/bin/node',
        '/home/neptunia',
        'neptunia-bot',
        'neptunia-discord-interface',
        'neptunia-%i-interface',
      ]) {
        assert.equal(text.includes(old), false, `${name} (${scope}) still has ${old}`);
      }
    }
  });

  test(`${scope} units run the engine from the checkout with the given node and the two directories`, () => {
    // Bug: ExecStart keeps the server's node path, or the directories are those of the template.
    for (const name of UNIT_FILES.filter((one) => one.endsWith('.service'))) {
      const text = renderUnit(template(name), scope, VARS);
      assert.ok(valuesOf(text, 'ExecStart')[0]?.startsWith(`${VARS.node} `), name);
      assert.deepEqual(valuesOf(text, 'WorkingDirectory'), [VARS.rootDir], name);
      const env = valuesOf(text, 'Environment');
      assert.ok(env.includes(`NEPTUNIA_DATA_DIR=${VARS.dataDir}`), name);
    }
  });

  test(`${scope} units keep the instance specifier of the interface template`, () => {
    // Bug: the renderer treats %i as text and one unit file cannot start every interface.
    const text = renderUnit(template('neptunia-interface@.service'), scope, VARS);
    assert.ok(valuesOf(text, 'ExecStart')[0]?.includes('interface run %i'));
  });
}

test('user units name no User= or Group= and install into the default target', () => {
  // Bug: a user manager refuses a unit with User= or starts none at login because it waits for multi-user.target.
  for (const name of UNIT_FILES.filter((one) => one.endsWith('.service'))) {
    const text = renderUnit(template(name), 'user', VARS);
    assert.deepEqual(valuesOf(text, 'User'), [], name);
    assert.deepEqual(valuesOf(text, 'Group'), [], name);
    assert.equal(valuesOf(text, 'WantedBy').includes('multi-user.target'), false, name);
  }
  assert.deepEqual(valuesOf(renderUnit(template('neptunia-core.service'), 'user', VARS), 'WantedBy'), [
    'default.target',
  ]);
});

const MOUNT_SANDBOX = ['ProtectSystem', 'ProtectHome', 'ReadWritePaths', 'BindPaths', 'BindReadOnlyPaths'];
const STOPS_SUDO = ['NoNewPrivileges', 'CapabilityBoundingSet'];

test('agent units keep every sandbox directive in read and write, drop the mount sandbox in full, and sudo-blockers in sudo', () => {
  // Bug: the units drop the sandbox for every mode (the first draft of this test), so "subharness mode dev read" and
  // "write" are held by the backend alone; or sudo mode leaves NoNewPrivileges on and sudo cannot work.
  for (const name of AGENTS) {
    const kept = (mode: 'read' | 'write' | 'full' | 'sudo', scope: 'user' | 'system') =>
      renderUnit(template(name), scope, { ...VARS, mode });
    for (const scope of ['user', 'system'] as const) {
      for (const mode of ['read', 'write'] as const) {
        const text = kept(mode, scope);
        assert.deepEqual(valuesOf(text, 'ProtectSystem'), ['strict'], `${name} ${scope} ${mode}`);
        assert.deepEqual(valuesOf(text, 'NoNewPrivileges'), ['yes'], `${name} ${scope} ${mode}`);
      }
      for (const key of MOUNT_SANDBOX) assert.deepEqual(valuesOf(kept('full', scope), key), [], `${name} full ${key}`);
      assert.deepEqual(valuesOf(kept('full', scope), 'NoNewPrivileges'), ['yes'], `${name} full keeps NoNewPrivileges`);
      for (const key of [...MOUNT_SANDBOX, ...STOPS_SUDO])
        assert.deepEqual(valuesOf(kept('sudo', scope), key), [], `${name} sudo ${key}`);
    }
  }
});

test('user units drop the address allow-list and capability set only where the mode asks, never by scope', () => {
  // Bug: a user unit loses IPAddressDeny for the read-only server agent because the scope was blamed for it.
  const server = renderUnit(template('neptunia-agent-server.service'), 'user', { ...VARS, mode: 'read' });
  assert.deepEqual(valuesOf(server, 'IPAddressDeny'), ['any']);
  assert.deepEqual(valuesOf(server, 'CapabilityBoundingSet'), ['CAP_DAC_READ_SEARCH']);
});

test('user units drop the exclusions that rely on a second user, since there is one user', () => {
  // Bug: InaccessiblePaths on the memory database makes the core itself unable to open it.
  assert.deepEqual(
    valuesOf(renderUnit(template('neptunia-interface@.service'), 'user', VARS), 'InaccessiblePaths'),
    []
  );
});

test('system units run as the installing user and group, and keep the template hardening', () => {
  // Bug: --system installs units that run as a user that does not exist, or loses the agent sandbox.
  for (const name of UNIT_FILES.filter((one) => one.endsWith('.service'))) {
    const text = renderUnit(template(name), 'system', VARS);
    assert.deepEqual(valuesOf(text, 'User'), [VARS.user], name);
    assert.deepEqual(valuesOf(text, 'Group'), [VARS.group], name);
    assert.ok(valuesOf(text, 'WantedBy').includes('multi-user.target'), name);
  }
  const server = renderUnit(template('neptunia-agent-server.service'), 'system', VARS);
  assert.deepEqual(valuesOf(server, 'ProtectSystem'), ['strict']);
  assert.deepEqual(valuesOf(server, 'IPAddressDeny'), ['any']);
});

test("system agent units bind nothing of the installing user's home, and their PATH reaches its tools and the node", () => {
  // Bug: the unit binds /home/neptunia/.codex, which is not the login of this user, so every task fails backend-missing.
  // The backend's login lives in <private>/subharness/<backend>/, never in ~/.codex.
  for (const name of AGENTS) {
    const text = renderUnit(template(name), 'system', VARS);
    assert.deepEqual(valuesOf(text, 'BindPaths'), [], name);
    const dirs = (valuesOf(text, 'Environment').find((one) => one.startsWith('PATH=')) ?? '').slice(5).split(':');
    assert.ok(dirs.includes(`${VARS.home}/.local/bin`), name);
    assert.ok(dirs.includes(path.dirname(VARS.node)), name);
  }
});

// The core finds the subharness backend: its unit carries the PATH of the installing
// user's own tools and may write the backend's home, so the enable check reaches the binary and its login.

// The core's unit is the one under test.
const CORE_UNITS = ['neptunia-core.service'];

/** The folders of the unit's `Environment=PATH=` line. */
const pathDirsOf = (text: string): Array<string> =>
  (valuesOf(text, 'Environment').find((one) => one.startsWith('PATH=')) ?? '').slice(5).split(':').filter(Boolean);

for (const scope of ['user', 'system'] as const) {
  test(`${scope} core unit puts the user's ~/.local/bin and the node's folder on PATH`, () => {
    // Catches: codex installed under ~/.local/bin is not found by the core's enable check.
    for (const name of CORE_UNITS) {
      // UnitVars carries the list `backends`.
      const dirs = pathDirsOf(renderUnit(template(name), scope, { ...VARS, backends: ['codex'] }));
      assert.ok(dirs.includes(`${VARS.home}/.local/bin`), name);
      assert.ok(dirs.includes(path.dirname(VARS.node)), name);
      assert.ok(dirs.includes('/usr/bin'), name);
    }
  });
}

test('the core of a deployment with no backend names no backend home', () => {
  // Catches: a deployment without the subharness gets a ReadWritePaths of a folder that does not exist and the unit fails.
  // The core writes the backend's folder in the private layer, checked by the test "the core may write the persona's
  // backend folder"; ~/.codex and ~/.claude are no write paths of it.
  for (const name of CORE_UNITS) {
    // UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', { ...VARS, backends: [] });
    assert.equal(text.includes('/.codex') || text.includes('/.claude'), false, name);
  }
});

// A backend lives in the persona's private layer: the units let the agents
// and the core write `<private>/subharness/<backend>/` in place of the installing user's ~/.codex or ~/.claude.

/** The folders a unit may write: its `ReadWritePaths=` and `BindPaths=` entries, a leading `-` and a `:target` taken off. */
const writableEntriesOf = (text: string): Array<string> =>
  [...valuesOf(text, 'ReadWritePaths'), ...valuesOf(text, 'BindPaths')]
    .flatMap((one) => one.split(/\s+/))
    .filter(Boolean)
    .map((one) => one.replace(/^-/, '').split(':')[0] ?? '');

/** Whether one of `entries` is `dir` or a folder above it. */
const covers = (entries: ReadonlyArray<string>, dir: string): boolean =>
  entries.some((entry) => {
    const relative = path.relative(entry, dir);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });

/** The rendered lines of a unit that name the user's own backend homes. */
const userHomesIn = (text: string): Array<string> =>
  linesOf(text).filter((line) => line.includes(`${VARS.home}/.codex`) || line.includes(`${VARS.home}/.claude`));

const placeOf = (backend: string, privateDir = VARS.dataDir): string => path.join(privateDir, 'subharness', backend);

for (const scope of ['user', 'system'] as const) {
  test(`${scope} agent units in read and write may write the persona's backend folder, nothing above it, and no ~/.codex`, () => {
    // Catches: the agent units still bind the installing user's ~/.codex, so codex in the persona's folder cannot write its
    // session; or the whole private folder is bound and an agent edits keys.json, its own mode included.
    for (const name of AGENTS)
      for (const backend of ['codex', 'claude', 'opencode'] as const)
        for (const mode of ['read', 'write'] as const) {
          // UnitVars carries the list `backends`.
          const text = renderUnit(template(name), scope, { ...VARS, backends: [backend], mode });
          const label = `${name} ${backend} ${mode}`;
          assert.ok(covers(writableEntriesOf(text), placeOf(backend)), label);
          assert.equal(covers(writableEntriesOf(text), path.join(VARS.dataDir, 'keys.json')), false, label);
          assert.deepEqual(userHomesIn(text), [], label);
        }
  });
}

test("agent units bind the persona's backend folder when the private folder lies under the home they hide", () => {
  // Catches: the folder is given as ReadWritePaths under ProtectHome=tmpfs, where it does not exist, and the unit fails.
  const privateDir = `${VARS.home}/.neptunia`;
  for (const name of AGENTS) {
    // UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', {
      ...VARS,
      privateDir,
      dataDir: privateDir,
      backends: ['codex'],
      mode: 'write',
    });
    const bound = valuesOf(text, 'BindPaths')
      .flatMap((one) => one.split(/\s+/))
      .map((one) => one.replace(/^-/, '').split(':')[0] ?? '');
    assert.ok(covers(bound, placeOf('codex', privateDir)), name);
  }
});

test('agent units of a deployment with no backend bind no backend folder at all', () => {
  // Catches: a unit names a subharness folder that setup never made, or keeps ~/.codex, and fails to start.
  for (const name of AGENTS) {
    // UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', { ...VARS, backends: [], mode: 'write' });
    assert.equal(
      linesOf(text).some((line) => line.includes('/subharness')),
      false,
      name
    );
    assert.deepEqual(userHomesIn(text), [], name);
  }
});

test("the core may write the persona's backend folder and names neither ~/.codex nor ~/.claude", () => {
  // Catches: the core unit keeps ~/.claude in ReadWritePaths, a folder that may not exist, so the core fails to start.
  for (const backend of ['codex', 'claude', 'opencode'] as const) {
    // UnitVars carries the list `backends`.
    const text = renderUnit(template('neptunia-core.service'), 'system', { ...VARS, backends: [backend] });
    assert.ok(covers(writableEntriesOf(text), placeOf(backend)), backend);
    assert.deepEqual(userHomesIn(text), [], backend);
  }
});

// Several subharnesses: an agent unit binds the folder of every
// connected backend.

test('agent units bind the folder of every connected backend', () => {
  // Catches: only the first backend's folder is bound, so an agent the owner moved to claude cannot write claude's home.
  for (const name of AGENTS) {
    const text = renderUnit(template(name), 'user', { ...VARS, backends: ['codex', 'claude'], mode: 'write' });
    assert.ok(covers(writableEntriesOf(text), placeOf('codex')), name);
    assert.ok(covers(writableEntriesOf(text), placeOf('claude')), name);
  }
});

test('the scout unit replaces the persona folder with an empty one and shows only its agents and backends', () => {
  // Bug: InaccessiblePaths on the folder is mode 000, so the runner died on data/agents and could not reach its backend.
  const vars = { ...VARS, backends: ['opencode' as const] };
  const unit = renderUnit(template('neptunia-agent-scout.service'), 'system', vars);
  assert.deepEqual(valuesOf(unit, 'InaccessiblePaths'), []);
  assert.deepEqual(valuesOf(unit, 'TemporaryFileSystem'), [`${vars.dataDir}:ro`]);
  assert.ok(valuesOf(unit, 'BindReadOnlyPaths').join(' ').includes(`-${vars.dataDir}/agents`));
  assert.ok(valuesOf(unit, 'BindPaths').join(' ').includes(`-${vars.dataDir}/subharness/opencode`));
});

test('the mode full drops the empty persona folder with the rest of the mount sandbox', () => {
  // Bug: a scout in full keeps the tmpfs, so an agent the owner opened up still sees no persona folder.
  const unit = renderUnit(template('neptunia-agent-scout.service'), 'system', { ...VARS, mode: 'full' });
  assert.deepEqual(valuesOf(unit, 'TemporaryFileSystem'), []);
});

// The two errand runner units (deploy/neptunia-agent-scout.service, deploy/neptunia-agent-server.service) as
// `neptunia setup` renders them: no `EnvironmentFile` line in any scope or mode, so a key never reaches a runner from a
// file beside the unit. Every key comes with the task. The interface unit has none either: its token is read from
// `interfaces/<name>/credentials.json`.

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DATA = '/srv/install/data';
const VARS_RUNNER_UNIT_NO_ENV_FILE: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/install',
  privateDir: DATA,
  dataDir: DATA,
  node: '/usr/bin/node',
};

const runnerUnitNoEnvFileTemplate = (file: string): string => fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
const environmentFiles = (text: string): Array<string> =>
  text.split('\n').filter((line) => /^\s*EnvironmentFile\s*=/.test(line));

for (const file of ['neptunia-agent-scout.service', 'neptunia-agent-server.service']) {
  for (const scope of ['user', 'system'] as const) {
    for (const mode of ['write', 'full', 'sudo'] as const) {
      test(`${file} rendered for ${scope} in mode ${mode} has no EnvironmentFile line`, () => {
        // Bug: a key copied into <data>/clients/agent-<name>.env is read by the runner and by every unit that can read the folder.
        const unit = renderUnit(runnerUnitNoEnvFileTemplate(file), scope, { ...VARS_RUNNER_UNIT_NO_ENV_FILE, mode });
        assert.deepEqual(environmentFiles(unit), []);
        assert.doesNotMatch(unit, /agent-(?:scout|server)\.env/);
      });
    }
  }
}

test('the interface unit has no EnvironmentFile line', () => {
  // Bug: a leftover `clients/<name>.env` line in the interface unit reads a file nothing writes, and invites a key into it.
  const unit = renderUnit(
    runnerUnitNoEnvFileTemplate('neptunia-interface@.service'),
    'system',
    VARS_RUNNER_UNIT_NO_ENV_FILE
  );
  assert.deepEqual(environmentFiles(unit), []);
});

// src/setup/install.ts and src/setup/units.ts: what the runner units are rendered with. Their binds follow the backends
// installed under `<data>/subharness/`, and the server unit's network reaches the API of each CLI. The templates are the
// real files of deploy/; no systemctl runs.

const run = (): Promise<RunResult> => Promise.resolve({ code: 0, stdout: '', stderr: '' });

/** The values of `key` in a rendered unit, its comments left out. */
const backendBindsValuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

for (const file of ['neptunia-agent-scout.service', 'neptunia-agent-server.service']) {
  test(`${file} binds the installed backend and not the uninstalled one while nothing is connected`, async () => {
    // Catches: the binds follow the connected list, so a role moved to an installed backend finds its folder hidden.
    const base = tempDir('nep-binds-');
    const dataDir = path.join(base, 'data');
    const unitDir = path.join(base, 'units');
    fs.mkdirSync(unitDir);
    writeKeysFile(dataDir, { subharness: { backends: [], key: null, modes: {} } });
    const { binary } = subharnessPlace(dataDir, 'claude');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    const target: UnitTarget = {
      system: false,
      user: 'alice',
      group: 'alice',
      home: path.join(base, 'home'),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: '/usr/bin/node',
      unitDir,
    };
    const done = await installUnits(target, run, [file]);
    assert.equal(done.ok, true);
    const unit = fs.readFileSync(path.join(unitDir, file), 'utf8');
    assert.deepEqual(backendBindsValuesOf(unit, 'BindPaths'), [`-${path.join(dataDir, 'subharness', 'claude')}`]);
  });
}

test("the server unit's network reaches Anthropic's API and Cloudflare's ranges, with everything else denied", () => {
  // Catches: a claude child under the server unit cannot connect at all, or the new range replaces the ones codex needs.
  const template = fs.readFileSync(path.join(ROOT, 'deploy', 'neptunia-agent-server.service'), 'utf8');
  const unit = renderUnit(template, 'system', {
    user: 'alice',
    group: 'alice',
    home: '/home/alice',
    rootDir: '/srv/engine',
    privateDir: '/srv/engine-data',
    dataDir: '/srv/engine-data',
    node: '/usr/bin/node',
    mode: 'read',
  });
  const allowed = backendBindsValuesOf(unit, 'IPAddressAllow').flatMap((value) => value.split(/\s+/));
  assert.ok(allowed.includes('160.79.104.0/23'), allowed.join(' '));
  assert.ok(allowed.includes('2607:6bc0::/48'), allowed.join(' '));
  assert.ok(allowed.includes('104.16.0.0/13'), allowed.join(' '));
  assert.deepEqual(backendBindsValuesOf(unit, 'IPAddressDeny'), ['any']);
});

// src/setup/units.ts with src/subharness/place.ts: every folder an opencode child writes lies in a path its runner unit
// leaves writable. Under `ProtectHome=tmpfs` the home is an empty read-only tmpfs and `ProtectSystem=strict` makes the
// rest read-only, so a folder opencode derives from HOME is unwritable there: with no XDG_CACHE_HOME, `opencode --version`
// fails `EACCES: mkdir ~/.cache` and exits 1 inside the scout's unit, as a transient unit of the
// same settings shows. The child is a fake opencode that writes its environment to a file; the templates are deploy/'s own.

/** The values of `key` in a rendered unit, its comments left out. */
const opencodeWritesValuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .flatMap((line) => line.slice(key.length + 1).split(/\s+/))
    .filter(Boolean);

/** The paths a unit lets its processes write: its writable binds and paths, and its own /tmp. */
function writablePaths(unit: string): Array<string> {
  const listed = [...opencodeWritesValuesOf(unit, 'BindPaths'), ...opencodeWritesValuesOf(unit, 'ReadWritePaths')].map(
    (one) => one.replace(/^-/, '')
  );
  return /^PrivateTmp=yes$/m.test(unit) ? [...listed, '/tmp', '/var/tmp'] : listed;
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** The folders opencode writes, from the environment it was started with: each XDG home, or its default under HOME. */
function opencodeWrites(env: Record<string, string>): Record<string, string> {
  const home = env.HOME ?? os.homedir();
  return {
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
    XDG_DATA_HOME: env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? path.join(home, '.cache'),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'),
  };
}

/** The environment an installed opencode is started with, read back from a fake binary that writes it to a file. */
async function childEnv(dataDir: string): Promise<Record<string, string>> {
  const dump = path.join(tempDir('nep-oc-env-'), 'env');
  const { binary } = subharnessPlace(dataDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\nenv > ${JSON.stringify(dump)}\nexit 0\n`, { mode: 0o755 });
  await createInstalledBackend('opencode', dataDir).run('B', { cwd: dataDir, timeoutMs: 5_000, env: {} });
  return Object.fromEntries(
    fs
      .readFileSync(dump, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
}

for (const [file, mode] of [
  ['neptunia-agent-scout.service', 'write'],
  ['neptunia-agent-code.service', 'write'],
  ['neptunia-agent-server.service', 'read'],
] as const) {
  test(`${file} leaves every folder an opencode child writes writable`, async () => {
    // Bug: opencode derives its cache folder from HOME, which the unit mounts as an empty read-only tmpfs, so every
    // opencode run of the agent exits 1 within a second while the same run outside the unit answers.
    const dataDir = tempDir('nep-oc-unit-');
    const env = await childEnv(dataDir);
    const template = fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
    const unit = renderUnit(template, 'system', {
      user: 'alice',
      group: 'alice',
      home: env.HOME ?? os.homedir(),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: process.execPath,
      mode,
      backends: ['opencode'],
    });
    const writable = writablePaths(unit);
    for (const [name, dir] of Object.entries(opencodeWrites(env)))
      assert.ok(
        writable.some((one) => inside(dir, one)),
        `${name} ${dir} lies in no writable path of the unit: ${writable.join(' ')}`
      );
  });
}

// The server unit denies every address it does not list, so a run told to use the stored proxy hangs on a denied
// address unless the unit lists the proxy's address too.
const PROXY_CASES: ReadonlyArray<readonly [string, string, Array<string>]> = [
  ['an IPv4 literal adds its /32', 'http://user:pass@192.0.2.10:8080', ['192.0.2.10/32']],
  ['an IPv6 literal adds its /128', 'socks5h://[2001:db8::7]:1080', ['2001:db8::7/128']],
  ['a host name adds nothing', 'http://proxy.example.com:8080', []],
  ['no stored proxy adds nothing', '', []],
];
for (const [what, proxy, added] of PROXY_CASES) {
  test(`the server unit admits the stored proxy when ${what}`, () => {
    // Bug: a Claude Code run sends every request to the proxy address the unit denies and hangs to its time limit.
    const base = valuesOf(renderUnit(template('neptunia-agent-server.service'), 'system', VARS), 'IPAddressAllow');
    const vars: UnitVars = proxy === '' ? VARS : { ...VARS, proxy };
    for (const mode of ['read', 'sudo'] as const) {
      const text = renderUnit(template('neptunia-agent-server.service'), 'system', { ...vars, mode });
      assert.deepEqual(valuesOf(text, 'IPAddressAllow'), [...base, ...added], mode);
    }
  });
}

test('the scout unit never lists the stored proxy, since its filter denies only local ranges', () => {
  // Bug: the proxy line goes to every unit with an address list, not only the one that denies all.
  const text = renderUnit(template('neptunia-agent-scout.service'), 'system', {
    ...VARS,
    proxy: 'http://192.0.2.10:8080',
  });
  assert.deepEqual(valuesOf(text, 'IPAddressAllow'), ['127.0.0.53/32']);
});

// What the server agent's unit hides from the agent it runs. It runs as the user of the core, so the mount namespace is
// all that keeps a child of its agent from reading a client's token or an interface's credentials. `renderUnit` takes
// the names of the clients (`clients`) and of the interfaces (`interfaces`) the install has and writes one
// `InaccessiblePaths=-<path>` entry per token and per interface `credentials.json`. The leading `-` lets the unit start
// when a file is missing. The server unit connects as no client, so it hides every token.

const SECRETS_VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/install',
  privateDir: DATA,
  dataDir: DATA,
  node: '/usr/bin/node',
  clients: ['cli', 'owner', 'development', 'watcher', 'discord'],
  interfaces: ['discord', 'telegram'],
};

/** The units under test and the client each one connects as. */
const AGENT_UNITS = [{ file: 'neptunia-agent-server.service' }] as const;

const secretsTemplate = (file: string): string => fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');

const render = (file: string, scope: 'user' | 'system', over: Partial<UnitVars> = {}): string =>
  renderUnit(secretsTemplate(file), scope, { ...SECRETS_VARS, ...over });

/** Every path any `InaccessiblePaths=` line names, with the `-` that lets it be missing kept. */
const hiddenOf = (text: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('InaccessiblePaths='))
    .flatMap((line) => line.slice('InaccessiblePaths='.length).split(/\s+/))
    .filter((one) => one !== '');

const token = (name: string): string => `${DATA}/clients/${name}.token`;

const credentials = (name: string): string => `${DATA}/interfaces/${name}/credentials.json`;

/** Whether `child` is `parent` or lies inside it. */
const secretsCovers = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`);

for (const { file } of AGENT_UNITS) {
  for (const scope of ['user', 'system'] as const) {
    test(`${file} as a ${scope} unit hides every client's token from its agent`, () => {
      // Bug: the agent runs as the core's user, so cli.token is readable, and a child that connects to the core's
      // socket with it acts as the owner: it spends keys and reads the Discord token.
      const hidden = hiddenOf(render(file, scope));
      for (const other of SECRETS_VARS.clients ?? []) {
        assert.ok(hidden.includes(`-${token(other)}`), `${token(other)} missing from ${hidden.join(' ')}`);
      }
    });

    test(`${file} as a ${scope} unit hides the credentials of every interface`, () => {
      // Bug: interfaces/discord/credentials.json holds the Discord token; any child of the unit could read it.
      const hidden = hiddenOf(render(file, scope));
      for (const name of SECRETS_VARS.interfaces ?? []) {
        assert.ok(hidden.includes(`-${credentials(name)}`), `${credentials(name)} missing from ${hidden.join(' ')}`);
      }
    });
  }

  test(`${file} writes every hidden path with the leading minus, so a missing file does not stop the unit`, () => {
    // Bug: before `neptunia setup` made a token or an interface, the unit fails to start with status 226.
    const hidden = hiddenOf(render(file, 'system'));
    assert.ok(hidden.length > 0);
    assert.deepEqual(
      hidden.filter((one) => !one.startsWith('-/')),
      []
    );
  });

  test(`${file} renders the same hidden paths whatever order the names come in, one entry each`, () => {
    // Bug: the same client twice (an interface client named like its folder) makes a duplicate entry per run, and a
    // re-render of an unchanged install rewrites the unit file and restarts the worker.
    const there = hiddenOf(render(file, 'system', { clients: ['discord', 'owner', 'cli', 'development', 'watcher'] }));
    const again = hiddenOf(
      render(file, 'system', {
        clients: ['watcher', 'development', 'cli', 'owner', 'discord', 'owner'],
        interfaces: ['telegram', 'discord', 'discord'],
      })
    );
    assert.ok(there.length > 0);
    assert.deepEqual([...again].sort(), [...there].sort());
    assert.equal(new Set(there).size, there.length);
  });

  test(`${file} in the modes full and sudo drops the mount sandbox, hidden paths included`, () => {
    // The documented meaning of the modes: the owner who sets `full` asks for no mount sandbox (docs/errands.md#modes).
    assert.ok(hiddenOf(render(file, 'system', { mode: 'write' })).length > 0);
    for (const mode of ['full', 'sudo'] as const) {
      assert.deepEqual(hiddenOf(render(file, 'system', { mode })), [], `${file} in ${mode}`);
    }
  });

  test(`${file} with a client name that could climb out of clients/ hides nothing outside the data folder`, () => {
    // Bug: a name from clients.json with a `..` segment turns an entry into a path elsewhere on the disk.
    const hidden = hiddenOf(
      render(file, 'system', { clients: ['owner', '../keys', 'a/b'], interfaces: ['../../etc'] })
    );
    for (const one of hidden)
      assert.ok(
        secretsCovers(`${DATA}/clients`, one.slice(1)) || secretsCovers(`${DATA}/interfaces`, one.slice(1)),
        one
      );
    assert.ok(hidden.includes(`-${token('owner')}`));
    assert.equal(
      hidden.some((one) => one.includes('..')),
      false
    );
  });
}

test('the core, the interfaces and the scout and code units get no hidden token: they need theirs', () => {
  // Bug: the same entries on the core or on an interface unit would lock the core out of every client's token.
  // The server unit is tested below: the server agent reads the host, not the persona's credentials.
  for (const file of ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-agent-code.service']) {
    const hidden = hiddenOf(render(file, 'system'));
    assert.equal(
      hidden.some((one) => one.includes('/clients/') || one.includes('credentials.json')),
      false,
      `${file}: ${hidden.join(' ')}`
    );
  }
});

test('the server unit hides every token and every credentials.json, and drops them in the mode full', () => {
  // Bug: the server agent runs as the core's user with no persona folder emptied, so it could read owner.token. It connects
  // as no client, so it keeps no token. It reads the host, not the persona's credentials.
  const hidden = hiddenOf(render('neptunia-agent-server.service', 'system'));
  for (const name of SECRETS_VARS.clients ?? []) assert.ok(hidden.includes(`-${token(name)}`), name);
  for (const name of SECRETS_VARS.interfaces ?? []) assert.ok(hidden.includes(`-${credentials(name)}`), name);
  assert.deepEqual(hiddenOf(render('neptunia-agent-server.service', 'system', { mode: 'full' })), []);
});

// Node's compile cache in the rendered units: every Node process strips the types of about 800 engine modules afresh
// unless `NODE_COMPILE_CACHE` names a folder it may write. The units `neptunia setup` renders get a systemd cache folder
// and the variable that names it.

const CACHE_VARS: UnitVars = {
  user: 'alice',
  group: 'alice',
  home: '/home/alice',
  rootDir: '/srv/engine',
  privateDir: '/srv/engine-data',
  dataDir: '/srv/engine-data',
  node: '/usr/bin/node',
};

const SERVICES = UNIT_FILES.filter((name) => name.endsWith('.service'));

const cacheRendered = (name: string, scope: 'user' | 'system', mode?: UnitVars['mode']): Array<string> =>
  renderUnit(fs.readFileSync(path.join(ROOT, 'deploy', name), 'utf8'), scope, {
    ...CACHE_VARS,
    ...(mode ? { mode } : {}),
  })
    .split('\n')
    .map((line) => line.trim());

for (const scope of ['user', 'system'] as const)
  test(`every ${scope} service names a compile cache in the cache folder systemd makes writable for it`, () => {
    // Catches: a cache path the sandbox (ProtectSystem=strict, ProtectHome=tmpfs) keeps read-only, so Node silently
    // compiles every module again at each start.
    for (const name of SERVICES) {
      const lines = cacheRendered(name, scope);
      assert.ok(lines.includes('CacheDirectory=neptunia-compile'), `${name}: ${lines.join(' | ')}`);
      assert.ok(lines.includes('Environment=NODE_COMPILE_CACHE=%C/neptunia-compile'), name);
    }
  });

test('an agent unit keeps its compile cache in the modes that drop the mount sandbox', () => {
  // Catches: the cache dropped with the sandbox lines, so a full or sudo agent starts slower than a read one.
  for (const mode of ['full', 'sudo'] as const) {
    const lines = cacheRendered('neptunia-agent-server.service', 'system', mode);
    assert.ok(lines.includes('Environment=NODE_COMPILE_CACHE=%C/neptunia-compile'), mode);
  }
});
