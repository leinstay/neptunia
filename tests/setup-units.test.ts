// src/setup/units.ts: the unit templates of deploy/ rendered for the installing user, as user units (no User=, default
// target) or as system units (User= the installing user). The templates are the real files of deploy/, so a template
// edit the renderer does not know fails here. Only the lines of a unit that matter are read, like
// tests/deploy-watcher-unit.test.ts; comments are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNIT_FILES, renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';

const DEPLOY = path.join(import.meta.dirname, '..', 'deploy');

const VARS: UnitVars = {
  user: 'alice',
  group: 'alice',
  home: '/home/alice',
  rootDir: '/srv/engine',
  privateDir: '/srv/engine-private',
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
    const vars: UnitVars = { ...VARS, home: '/home/installer', [field]: `/home/neptunia/worktree/${field}` };
    const text = renderUnit(template('neptunia-core.service'), 'user', vars);
    assert.deepEqual(valuesOf(text, 'WorkingDirectory'), [vars.rootDir]);
    const env = valuesOf(text, 'Environment');
    assert.ok(env.includes(`NEPTUNIA_PRIVATE_DIR=${vars.privateDir}`));
    assert.ok(env.includes(`NEPTUNIA_DATA_DIR=${vars.dataDir}`));
    const dirs = (env.find((value) => value.startsWith('PATH=')) ?? '').slice(5).split(':');
    assert.ok(dirs.includes(`${vars.home}/.local/bin`));
  });
}

test('setup renders these six templates and not the bot unit or the plugin template', () => {
  // Bug: the bot unit (which conflicts with the core) is installed beside the core, or a template is forgotten.
  assert.deepEqual(
    [...UNIT_FILES].sort(),
    [
      'neptunia-agent-scout.service',
      'neptunia-agent-server.service',
      'neptunia-core.service',
      'neptunia-interface@.service',
      'neptunia-watcher.service',
      'neptunia-watcher.timer',
    ].sort()
  );
  for (const name of UNIT_FILES) assert.ok(fs.existsSync(path.join(DEPLOY, name)), name);
});

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
      assert.ok(env.includes(`NEPTUNIA_PRIVATE_DIR=${VARS.privateDir}`), name);
      assert.ok(env.includes(`NEPTUNIA_DATA_DIR=${VARS.dataDir}`), name);
    }
  });

  test(`${scope} units keep the instance specifier of the interface template`, () => {
    // Bug: the renderer treats %i as text and one unit file can no longer start every interface.
    const text = renderUnit(template('neptunia-interface@.service'), scope, VARS);
    assert.ok(valuesOf(text, 'ExecStart')[0]?.includes('interface run %i'));
  });

  test(`${scope} rendering twice gives the same text`, () => {
    // Bug: a rerun of setup rewrites every unit and restarts the core for nothing.
    for (const name of UNIT_FILES) {
      assert.equal(renderUnit(template(name), scope, VARS), renderUnit(template(name), scope, VARS));
    }
  });

  test(`${scope} timer still fires the watcher service from the timers target`, () => {
    // Bug: the timer loses its Unit= or its install target and never fires.
    const text = renderUnit(template('neptunia-watcher.timer'), scope, VARS);
    assert.deepEqual(valuesOf(text, 'WantedBy'), ['timers.target']);
    assert.ok(valuesOf(text, 'Unit').every((one) => one === 'neptunia-watcher.service'));
    assert.ok(valuesOf(text, 'OnCalendar')[0]?.includes('UTC'));
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
    // The watcher service is a oneshot that its timer starts: the template has no [Install] section, and none is added.
    if (name !== 'neptunia-watcher.service') assert.ok(valuesOf(text, 'WantedBy').includes('multi-user.target'), name);
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

test('the core unit of a user install does not name the bot unit it conflicts with', () => {
  // Bug: Conflicts=neptunia-bot.service in a unit set that has no such unit makes systemd warn on every start.
  assert.deepEqual(valuesOf(renderUnit(template('neptunia-core.service'), 'user', VARS), 'Conflicts'), []);
});

// The core and the watcher find the subharness backend (spec 2026-11-02, follow-up 6): their units carry the PATH of
// the installing user's own tools and may write the backend's home, so the enable check and the watcher's run reach
// the binary and its login.

const CORE_AND_WATCHER = ['neptunia-core.service', 'neptunia-watcher.service'];

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

const placeOf = (backend: string, privateDir = VARS.privateDir): string => path.join(privateDir, 'subharness', backend);

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
          assert.equal(covers(writableEntriesOf(text), path.join(VARS.privateDir, 'keys.json')), false, label);
          assert.deepEqual(userHomesIn(text), [], label);
        }
  });
}

test('agent units bind her backend folder when the private folder lies under the home they hide', () => {
  // Catches: the folder is given as ReadWritePaths under ProtectHome=tmpfs, where it does not exist, and the unit fails.
  const privateDir = `${VARS.home}/.neptunia`;
  for (const name of AGENTS) {
    // Changed for spec 2026-11-02 PR 5 "Several subharnesses": UnitVars carries the list `backends`.
    const text = renderUnit(template(name), 'user', { ...VARS, privateDir, backends: ['codex'], mode: 'write' });
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

test('the watcher timer fires at the hour it is rendered with', () => {
  // Catches: watcher.at is stored but the timer keeps the template's midnight, so the watcher runs after her wake.
  const text = renderUnit(template('neptunia-watcher.timer'), 'user', { ...VARS, watcherAt: '05:30' });
  assert.deepEqual(valuesOf(text, 'OnCalendar'), ['*-*-* 05:30:00 UTC']);
});

test('the watcher timer rendered with no hour keeps the template line', () => {
  // Catches: a missing hour renders an empty or "undefined" OnCalendar and systemd refuses the timer.
  const text = renderUnit(template('neptunia-watcher.timer'), 'user', VARS);
  assert.deepEqual(valuesOf(text, 'OnCalendar'), valuesOf(template('neptunia-watcher.timer'), 'OnCalendar'));
});

test("the watcher's hour changes no other timer", () => {
  // Catches: every OnCalendar line is rewritten, and the hourly selfimprovement beat turns into a daily one.
  const selfimprovement = template('neptunia-selfimprovement.timer');
  const text = renderUnit(selfimprovement, 'user', { ...VARS, watcherAt: '05:30' });
  assert.deepEqual(valuesOf(text, 'OnCalendar'), valuesOf(selfimprovement, 'OnCalendar'));
});
