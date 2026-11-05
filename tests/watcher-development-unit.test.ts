// What the watcher's unit gives a child in development mode: read access to the development checkout and a writable
// scratch under the watcher's own folder, `<data>/agents/watcher/scratch`. `renderUnit` takes both from
// `watcherDevelopment`, which `neptunia setup` fills only when the mode is on (`developmentMode` in
// src/watcher/development.ts). With the mode off neither line exists, whatever `developmentCheckout` says for the
// development worker's own unit. The checkout stays read-only: the watcher reports and never changes code.
// No systemd is touched, and the folders are temporary ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from '../src/setup/run.ts';
import type { SetupDeps, SetupOptions } from '../src/setup/run.ts';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = '/srv/install/data';
const CHECKOUT = '/srv/dev-checkout';
const SCRATCH = `${DATA}/agents/watcher/scratch`;
const VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/install',
  privateDir: DATA,
  dataDir: DATA,
  node: '/usr/bin/node',
  developmentCheckout: CHECKOUT,
};

const template = (file: string): string => fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
const render = (scope: 'user' | 'system', over: Partial<UnitVars> = {}, file = 'neptunia-watcher.service'): string =>
  renderUnit(template(file), scope, { ...VARS, ...over });

/** Every path the lines of `key` name, with the `-` that lets it be missing taken off. */
const pathsOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .flatMap((line) => line.slice(key.length + 1).split(/\s+/))
    .filter((one) => one !== '')
    .map((one) => one.replace(/^-/, ''));

const ON = { watcherDevelopment: { checkout: CHECKOUT } };

/** What every test of an absence asks first: the render does know the mode, so the absence says something. */
const rendersTheMode = (): void => {
  assert.deepEqual(pathsOf(render('system', ON), 'ReadOnlyPaths'), [CHECKOUT]);
};

for (const scope of ['user', 'system'] as const) {
  test(`in development mode a ${scope} unit reads the checkout`, () => {
    // Bug: the prompt tells the agent to run files from a folder its unit does not name.
    assert.deepEqual(pathsOf(render(scope, ON), 'ReadOnlyPaths'), [CHECKOUT]);
  });

  test(`in development mode a ${scope} unit names the scratch writable and keeps its two folders`, () => {
    // Bug: the scratch line replaces the template's, and the worker cannot write its report.
    const writable = pathsOf(render(scope, ON), 'ReadWritePaths');
    assert.ok(writable.includes(SCRATCH), writable.join(' '));
    assert.ok(writable.includes(`${DATA}/agents/watcher`), writable.join(' '));
    assert.ok(writable.includes(`${DATA}/subharness`), writable.join(' '));
  });

  test(`out of development mode a ${scope} unit names neither, though the setting names a checkout`, () => {
    // The owner's word: without development agents and a dev folder the watcher does not touch code.
    rendersTheMode();
    for (const off of [{}, { watcherDevelopment: null }]) {
      const text = render(scope, off);
      assert.deepEqual(pathsOf(text, 'ReadOnlyPaths'), []);
      assert.equal(pathsOf(text, 'ReadWritePaths').includes(SCRATCH), false);
      assert.equal(
        text.split('\n').some((line) => !line.startsWith('#') && line.includes(CHECKOUT)),
        false
      );
    }
  });
}

test('the checkout is never writable to the watcher, in or out of the mode', () => {
  // Bug: the checkout goes on the line `developmentCheckout` feeds, and a child of the watcher can edit the code it judges.
  rendersTheMode();
  for (const over of [ON, {}]) {
    const writable = pathsOf(render('system', over), 'ReadWritePaths');
    assert.equal(
      writable.some((one) => one === CHECKOUT || one.startsWith(`${CHECKOUT}/`)),
      false,
      writable.join(' ')
    );
  }
});

test('the read line lets the unit start with the folder gone', () => {
  // Bug: a removed checkout fails the unit with status 226, and the owner gets no report saying the checkout is gone.
  assert.ok(render('system', ON).split('\n').includes(`ReadOnlyPaths=-${CHECKOUT}`));
});

test('the hidden tokens stay hidden in the mode', () => {
  // Bug: the new lines replace the mount sandbox's own, and a test run from the checkout reads the owner's token.
  rendersTheMode();
  const text = render('system', { ...ON, clients: ['owner', 'watcher'] });
  // Changed by the lead's ruling on stage S: the unit also hides the checkout's `.env` in the mode.
  assert.deepEqual(pathsOf(text, 'InaccessiblePaths'), [`${DATA}/clients/owner.token`, `${CHECKOUT}/.env`]);
});

for (const mode of ['full', 'sudo'] as const) {
  test(`the mode ${mode} drops the read line with the rest of the mount sandbox`, () => {
    // Bug: a mount line survives in a unit that asked for none, and the unit's namespace differs from the documented one.
    rendersTheMode();
    assert.deepEqual(pathsOf(render('system', { ...ON, mode }), 'ReadOnlyPaths'), []);
  });
}

test('no other unit takes the lines', () => {
  // Bug: the render adds them by the var alone, and the core's unit gets a read-only view of a checkout.
  rendersTheMode();
  for (const file of ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-development.service']) {
    const text = render('system', ON, file);
    assert.deepEqual(pathsOf(text, 'ReadOnlyPaths'), [], file);
    assert.equal(pathsOf(text, 'ReadWritePaths').includes(SCRATCH), false, file);
  }
});

// ---------- the same lines, through `neptunia setup` ----------

/** A setup rig whose settings and keys say what `selfimprovement` and `uses` are given. */
function rig(selfimprovement: Record<string, unknown>, uses: Record<string, 'claude'>) {
  const base = tempDir('nep-watcher-dev-unit-');
  const dataDir = path.join(base, 'data');
  const checkout = path.join(base, 'dev-checkout');
  const xdg = path.join(base, 'xdg');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config', 'config.json'),
    JSON.stringify({ selfimprovement: { checkout, ...selfimprovement } })
  );
  // Changed: `readKeys` gives every agent the first connected backend when `uses` does not name it, so a rig with no `dev`
  // connects none, and `the dev agent has no backend` holds in the file as the engine reads it.
  const backends: Array<'claude'> = Object.keys(uses).length === 0 ? [] : ['claude'];
  writeKeysFile(dataDir, { subharness: { backends, key: null, modes: {}, models: {}, uses } });
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
  const unit = (): string => fs.readFileSync(path.join(xdg, 'systemd', 'user', 'neptunia-watcher.service'), 'utf8');
  return { options, deps, checkout, dataDir, unit };
}

test('setup writes the lines when the settings and the keys make the mode on', async () => {
  // Bug: the render can do it and setup never passes the var, so the units on disk keep no way into the checkout.
  const { options, deps, checkout, dataDir, unit } = rig({ repository: 'example/engine' }, { dev: 'claude' });
  await runSetup(options, deps);
  assert.deepEqual(pathsOf(unit(), 'ReadOnlyPaths'), [checkout]);
  assert.ok(pathsOf(unit(), 'ReadWritePaths').includes(path.join(dataDir, 'agents', 'watcher', 'scratch')));
});

for (const [name, settings, uses] of [
  ['the dev agent has no backend', { repository: 'example/engine' }, {}],
  ['no repository is named', {}, { dev: 'claude' }],
  ['development is disabled', { repository: 'example/engine', enabled: false }, { dev: 'claude' }],
] as ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, 'claude'>]>) {
  test(`setup writes neither line when ${name}`, async () => {
    // Bug: setup asks only for `selfimprovement.checkout`, as it does for the worker's unit, so half a configuration
    // gives the watcher code it must not touch.
    rendersTheMode();
    const { options, deps, dataDir, unit } = rig(settings, uses);
    await runSetup(options, deps);
    assert.deepEqual(pathsOf(unit(), 'ReadOnlyPaths'), []);
    assert.equal(pathsOf(unit(), 'ReadWritePaths').includes(path.join(dataDir, 'agents', 'watcher', 'scratch')), false);
  });
}
