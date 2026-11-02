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

test("system agent units bind the installing user's home, and their PATH reaches its codex and the node", () => {
  // Bug: the unit binds /home/neptunia/.codex, which is not the login of this user, so every task fails backend-missing.
  for (const name of AGENTS) {
    const text = renderUnit(template(name), 'system', VARS);
    assert.deepEqual(valuesOf(text, 'BindPaths'), [`${VARS.home}/.codex`], name);
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

/** The folders the unit's `ReadWritePaths=` lines name, a leading `-` taken off. */
const writableOf = (text: string): Array<string> =>
  valuesOf(text, 'ReadWritePaths')
    .flatMap((one) => one.split(/\s+/))
    .map((one) => one.replace(/^-/, ''));

for (const scope of ['user', 'system'] as const) {
  test(`${scope} core and watcher units put the user's ~/.local/bin and the node's folder on PATH`, () => {
    // Catches: codex installed under ~/.local/bin is not found by the core's enable check or the watcher's run.
    for (const name of CORE_AND_WATCHER) {
      const dirs = pathDirsOf(renderUnit(template(name), scope, { ...VARS, backend: 'codex' }));
      assert.ok(dirs.includes(`${VARS.home}/.local/bin`), name);
      assert.ok(dirs.includes(path.dirname(VARS.node)), name);
      assert.ok(dirs.includes('/usr/bin'), name);
    }
  });
}

test('the core may write the home of the backend that is on: ~/.codex for codex, ~/.claude for claude, none for none', () => {
  // Catches: ProtectSystem=strict leaves the backend's home read-only and every run fails writing its session, or a
  // deployment without the subharness gets a ReadWritePaths of a folder that does not exist and the unit fails.
  const core = (backend: 'codex' | 'claude' | null): string =>
    renderUnit(template('neptunia-core.service'), 'user', { ...VARS, backend });
  assert.ok(writableOf(core('codex')).includes(`${VARS.home}/.codex`));
  assert.ok(writableOf(core('claude')).includes(`${VARS.home}/.claude`));
  assert.equal(writableOf(core('claude')).includes(`${VARS.home}/.codex`), false);
  for (const name of CORE_AND_WATCHER) {
    const text = renderUnit(template(name), 'user', { ...VARS, backend: null });
    assert.equal(text.includes('/.codex') || text.includes('/.claude'), false, name);
  }
});
