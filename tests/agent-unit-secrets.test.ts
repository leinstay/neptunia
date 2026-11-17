// What the server agent's unit hides from the agent it runs. It runs as the user of the core, so the mount namespace is
// all that keeps a child of its agent from reading a client's token or an interface's credentials. `renderUnit`
// (src/setup/units.ts) takes the names of the clients (`clients`) and of the interfaces (`interfaces`) the install has
// and writes one `InaccessiblePaths=-<path>` entry per token and per interface `credentials.json`. The leading `-` lets
// the unit start when a file is missing. No systemd is touched; the folders are temporary ones.
// Changed: the development worker's unit is gone with the worker (maintainer, 2026-11-16), so the generic checks of a
// hiding unit run over the server unit, which connects as no client and so hides every token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from '../src/setup/run.ts';
import type { SetupDeps, SetupOptions } from '../src/setup/run.ts';
import { addClient } from '../src/setup/clients.ts';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = '/srv/install/data';
const VARS: UnitVars = {
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
// Changed: the server agent has a unit of its own name.
const AGENT_UNITS = [{ file: 'neptunia-agent-server.service' }] as const;

const template = (file: string): string => fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
const render = (file: string, scope: 'user' | 'system', over: Partial<UnitVars> = {}): string =>
  renderUnit(template(file), scope, { ...VARS, ...over });

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
const covers = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`);

for (const { file } of AGENT_UNITS) {
  for (const scope of ['user', 'system'] as const) {
    test(`${file} as a ${scope} unit hides every client's token from its agent`, () => {
      // Bug: the agent runs as the core's user, so cli.token is readable, and a child that connects to the core's
      // socket with it acts as the owner: it spends keys and reads the Discord token.
      const hidden = hiddenOf(render(file, scope));
      for (const other of VARS.clients ?? []) {
        assert.ok(hidden.includes(`-${token(other)}`), `${token(other)} missing from ${hidden.join(' ')}`);
      }
    });

    test(`${file} as a ${scope} unit hides the credentials of every interface`, () => {
      // Bug: interfaces/discord/credentials.json holds the Discord token; any child of the unit could read it.
      const hidden = hiddenOf(render(file, scope));
      for (const name of VARS.interfaces ?? []) {
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
      assert.ok(covers(`${DATA}/clients`, one.slice(1)) || covers(`${DATA}/interfaces`, one.slice(1)), one);
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
  // Changed: the scout and code agents have units of their own names.
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
  for (const name of VARS.clients ?? []) assert.ok(hidden.includes(`-${token(name)}`), name);
  for (const name of VARS.interfaces ?? []) assert.ok(hidden.includes(`-${credentials(name)}`), name);
  assert.deepEqual(hiddenOf(render('neptunia-agent-server.service', 'system', { mode: 'full' })), []);
});

// ---------- the same lines, through `neptunia setup` ----------

/** One setup rig with a Discord interface folder and an interface client. */
function rig() {
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
  const { options, deps, dataDir, rendered } = rig();
  await runSetup(options, deps);
  for (const { file } of AGENT_UNITS) {
    const hidden = hiddenOf(rendered(file));
    // cli is made by this very step, so it is hidden on the first render, not the second.
    // Changed: setup makes no owner and no development client, and the server unit keeps no token of its own.
    for (const other of ['cli', 'matrix']) {
      assert.ok(hidden.includes(`-${path.join(dataDir, 'clients', `${other}.token`)}`), `${file}: ${other}`);
    }
    assert.ok(hidden.includes(`-${path.join(dataDir, 'interfaces', 'discord', 'credentials.json')}`), file);
    assert.ok(hidden.includes(`-${path.join(dataDir, 'interfaces', 'matrix', 'credentials.json')}`), file);
  }
});
