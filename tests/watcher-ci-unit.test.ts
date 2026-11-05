// The watcher unit's environment and the `gh` login. The worker of the unit lists the CI with `gh`, and `gh` finds its login
// through `GH_CONFIG_DIR`. In development mode the unit names the login the development worker uses (the installing user's
// own `<home>/.config/gh`, no token of its own). Out of the mode it names a folder that holds no login, so a `gh` that the
// worker or its child starts reads nothing. No other unit takes the line. No systemd is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = '/srv/install/data';
const HOME = '/home/someone';
const CHECKOUT = '/srv/dev-checkout';
const VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: HOME,
  rootDir: '/srv/install',
  privateDir: DATA,
  dataDir: DATA,
  node: '/usr/bin/node',
  developmentCheckout: CHECKOUT,
};
const ON = { watcherDevelopment: { checkout: CHECKOUT } };

const render = (scope: 'user' | 'system', over: Partial<UnitVars> = {}, file = 'neptunia-watcher.service'): string =>
  renderUnit(fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8'), scope, { ...VARS, ...over });

/** The values of every active `Environment=GH_CONFIG_DIR=` line. */
const ghDirs = (text: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('Environment=GH_CONFIG_DIR='))
    .map((line) => line.slice('Environment=GH_CONFIG_DIR='.length));

for (const scope of ['user', 'system'] as const) {
  test(`in development mode a ${scope} unit points gh at the installing user's own login`, () => {
    // Bug: the owner's word is the development checkout's own login with no separate token, and the unit names another.
    assert.deepEqual(ghDirs(render(scope, ON)), [`${HOME}/.config/gh`]);
  });

  test(`out of development mode a ${scope} unit points gh at a folder inside the watcher's own that holds no login`, () => {
    // Bug: without development the watcher still finds the user's login through HOME and reads CI.
    const dirs = ghDirs(render(scope));
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0]?.startsWith(`${DATA}/agents/watcher/`), dirs.join(' '));
    assert.notEqual(dirs[0], `${HOME}/.config/gh`);
    assert.deepEqual(ghDirs(render(scope, { watcherDevelopment: null })), dirs);
  });
}

test('the login folder of the mode off is the same in a user and a system unit', () => {
  // Bug: a path that differs by scope leaves a stale unit pointing at a folder the next setup does not know.
  assert.deepEqual(ghDirs(render('system')), ghDirs(render('user')));
});

test('no token variable is set in either mode', () => {
  // Bug: the owner said no separate token, and a `GH_TOKEN` line puts one in a unit file anyone on the machine reads.
  for (const over of [ON, {}]) {
    const text = render('system', over);
    assert.equal(/^Environment=(GH_TOKEN|GITHUB_TOKEN)=/m.test(text), false);
  }
});

test('the other units carry no gh line', () => {
  // Bug: the render adds the line by the var alone, and the core or the development worker loses the login it needs.
  for (const file of ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-development.service']) {
    assert.deepEqual(ghDirs(render('system', ON, file)), [], file);
  }
});
