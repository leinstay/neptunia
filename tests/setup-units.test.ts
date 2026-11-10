// src/setup/units.ts: the unit templates of deploy/ rendered for the installing user, as user units (no User=, default
// target) or as system units (User= the installing user). The templates are the real files of deploy/, so a template
// edit the renderer does not know fails here. Only the lines of a unit that matter are read; comments are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNIT_FILES, renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { installUnits } from '../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../src/setup/install.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import os from 'node:os';
import { createInstalledBackend } from '../src/agent-runner/backend.ts';

const DEPLOY = path.join(import.meta.dirname, '..', 'deploy');

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

const AGENTS = ['neptunia-agent-scout.service', 'neptunia-agent-server.service'];

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
    // Bug: the renderer treats %i as text and one unit file can no longer start every interface.
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
  // Changed for spec 2026-11-02 PR 5: the backend's login lives in <private>/subharness/<backend>/, never in ~/.codex.
  for (const name of AGENTS) {
    const text = renderUnit(template(name), 'system', VARS);
    assert.deepEqual(valuesOf(text, 'BindPaths'), [], name);
    const dirs = (valuesOf(text, 'Environment').find((one) => one.startsWith('PATH=')) ?? '').slice(5).split(':');
    assert.ok(dirs.includes(`${VARS.home}/.local/bin`), name);
    assert.ok(dirs.includes(path.dirname(VARS.node)), name);
  }
});

// The core and the watcher find the subharness backend (spec 2026-11-02, follow-up 6): their units carry the PATH of
// the installing user's own tools and may write the backend's home, so the enable check and the watcher's run reach
// the binary and its login.

// Changed: the watcher runs inside the core's unit (owner, 2026-11-09), so the core stands for both.
const CORE_AND_WATCHER = ['neptunia-core.service'];

/** The folders of the unit's `Environment=PATH=` line. */
const pathDirsOf = (text: string): Array<string> =>
  (valuesOf(text, 'Environment').find((one) => one.startsWith('PATH=')) ?? '').slice(5).split(':').filter(Boolean);

for (const scope of ['user', 'system'] as const) {
  test(`${scope} core and watcher units put the user's ~/.local/bin and the node's folder on PATH`, () => {
    // Catches: codex installed under ~/.local/bin is not found by the core's enable check or the watcher's run.
    for (const name of CORE_AND_WATCHER) {
      // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
      const dirs = pathDirsOf(renderUnit(template(name), scope, { ...VARS, backends: ['codex'] }));
      assert.ok(dirs.includes(`${VARS.home}/.local/bin`), name);
      assert.ok(dirs.includes(path.dirname(VARS.node)), name);
      assert.ok(dirs.includes('/usr/bin'), name);
    }
  });
}

test('the core and the watcher of a deployment with no backend name no backend home', () => {
  // Catches: a deployment without the subharness gets a ReadWritePaths of a folder that does not exist and the unit fails.
  // Changed for spec 2026-11-02 PR 5: the core writes the backend's folder in the private layer, checked by the test
  // "the core may write her backend's folder"; ~/.codex and ~/.claude are no longer its write paths.
  for (const name of CORE_AND_WATCHER) {
    // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', { ...VARS, backends: [] });
    assert.equal(text.includes('/.codex') || text.includes('/.claude'), false, name);
  }
});

// A backend lives in her private layer (spec 2026-11-02, PR 5, "Where a subharness lives"): the units let the agents
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
  test(`${scope} agent units in read and write may write her backend's folder, nothing above it, and no ~/.codex`, () => {
    // Catches: the agent units still bind the installing user's ~/.codex, so codex in her folder cannot write its
    // session; or the whole private folder is bound and an agent edits keys.json, its own mode included.
    for (const name of AGENTS)
      for (const backend of ['codex', 'claude', 'opencode'] as const)
        for (const mode of ['read', 'write'] as const) {
          // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
          const text = renderUnit(template(name), scope, { ...VARS, backends: [backend], mode });
          const label = `${name} ${backend} ${mode}`;
          assert.ok(covers(writableEntriesOf(text), placeOf(backend)), label);
          assert.equal(covers(writableEntriesOf(text), path.join(VARS.dataDir, 'keys.json')), false, label);
          assert.deepEqual(userHomesIn(text), [], label);
        }
  });
}

test('agent units bind her backend folder when the private folder lies under the home they hide', () => {
  // Catches: the folder is given as ReadWritePaths under ProtectHome=tmpfs, where it does not exist, and the unit fails.
  const privateDir = `${VARS.home}/.neptunia`;
  for (const name of AGENTS) {
    // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
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
    // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', { ...VARS, backends: [], mode: 'write' });
    assert.equal(
      linesOf(text).some((line) => line.includes('/subharness')),
      false,
      name
    );
    assert.deepEqual(userHomesIn(text), [], name);
  }
});

test("the core may write her backend's folder and names neither ~/.codex nor ~/.claude", () => {
  // Catches: the core unit keeps ~/.claude in ReadWritePaths, a folder that may not exist, so the core fails to start.
  for (const backend of ['codex', 'claude', 'opencode'] as const) {
    // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
    const text = renderUnit(template('neptunia-core.service'), 'system', { ...VARS, backends: [backend] });
    assert.ok(covers(writableEntriesOf(text), placeOf(backend)), backend);
    assert.deepEqual(userHomesIn(text), [], backend);
  }
});

// Several subharnesses and the watcher's hour (spec 2026-11-02, PR 5 "Several subharnesses", "`selfimprovement` daily,
// after the watcher"): an agent unit binds the folder of every connected backend, and the watcher timer fires at
// `watcher.at`.

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

const ROOT = path.join(import.meta.dirname, '..');
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
// fails `EACCES: mkdir ~/.cache` and exits 1 inside the scout's unit (measured 2026-11-05 with a transient unit of the
// same settings). The child is a fake opencode that writes its environment to a file; the templates are deploy/'s own.

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

test('the rendered system core joins the group that reads the journal, and a user core names no group', () => {
  // Bug: the watcher the core starts runs as a user outside `systemd-journal`, journalctl answers nothing, and the
  // report says the server was quiet. A user manager refuses `SupplementaryGroups=` with status 216, so that form
  // must not carry it.
  const rendered = (scope: 'user' | 'system') => renderUnit(template('neptunia-core.service'), scope, VARS).split('\n');
  assert.ok(rendered('system').includes('SupplementaryGroups=systemd-journal'));
  assert.equal(
    rendered('user').some((line) => line.startsWith('SupplementaryGroups=')),
    false
  );
});
