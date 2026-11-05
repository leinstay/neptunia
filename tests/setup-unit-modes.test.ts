// The units of the agents that follow a mode (src/setup/install.ts#unitText over src/setup/units.ts): `NoNewPrivileges=yes`
// stays in `read`, `write` and `full`, and only `sudo` drops it. The renderer can already do that for any template, but
// the development unit is not on `UNIT_AGENTS`, so it renders the default mode whatever the owner set for `dev`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitText } from '../src/setup/install.ts';
import { UNIT_AGENTS } from '../src/setup/units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const DEPLOY = path.join(fileURLToPath(new URL('..', import.meta.url)), 'deploy');
const UNITS = [
  ['neptunia-development.service', 'dev'],
  ['neptunia-agent-scout.service', 'scout'],
  ['neptunia-agent-server.service', 'server'],
] as const;

function rendered(file: string, agent: string, mode: string): string {
  const dataDir = tempDir('nep-unit-modes-');
  writeKeysFile(dataDir, { subharness: { backends: [], key: null, modes: { [agent]: mode }, models: {}, uses: {} } });
  const target = {
    user: 'alice',
    group: 'alice',
    home: '/home/alice',
    rootDir: '/srv/engine',
    privateDir: dataDir,
    dataDir,
    node: '/home/alice/.nvm/bin/node',
    developmentCheckout: '/srv/checkout',
    system: false,
  };
  return unitText(target, fs.readFileSync(path.join(DEPLOY, file), 'utf8'), file);
}

const hasGuard = (text: string): boolean => /^NoNewPrivileges=yes$/m.test(text);

test('the development unit follows the mode of dev', () => {
  // Bug: `subharness mode dev sudo` is stored, the unit keeps NoNewPrivileges, and sudo fails in every dev run.
  assert.equal(UNIT_AGENTS['neptunia-development.service'], 'dev');
});

test('the units keep NoNewPrivileges in read, write and full, and only sudo drops it', () => {
  // Bug: the guard goes with `full`, which should give up the mount sandbox and nothing else, or stays under `sudo`.
  for (const [file, agent] of UNITS) {
    const guarded = ['read', 'write', 'full', 'sudo'].map((mode) => [mode, hasGuard(rendered(file, agent, mode))]);
    assert.deepEqual(
      guarded,
      [
        ['read', true],
        ['write', true],
        ['full', true],
        ['sudo', false],
      ],
      file
    );
  }
});
