// The watcher holds no development role (the owner's word of 2026-11-06): with every condition of the old development
// mode met, `selfimprovement.checkout` naming a checkout among them, its unit names no checkout and no `gh` login, and its
// first evidence page runs no `gh` and no command on the checkout. No systemd is touched; folders are temporary ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { unitText } from '../src/setup/install.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-05T12:00:00Z');

/** A private layer whose settings name a development checkout, a repository and a backend for `dev`. */
function developmentLayer(): { data: string; checkout: string } {
  const data = tempDir('nep-no-development-');
  const checkout = tempDir('nep-dev-checkout-');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(
    localConfigPath(data),
    JSON.stringify({ selfimprovement: { enabled: true, checkout, repository: 'invented/engine' } })
  );
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  writeKeysFile(data, { subharness: { key: null, modes: {}, uses: { dev: 'claude', watcher: 'claude' } } });
  return { data, checkout };
}

// Bug: the unit still mounts the development checkout and hands `gh` the installing user's login, so a child of the
// watcher reads code and lists pull requests the owner took away from it.
test('the watcher unit names no checkout and no gh login, with a checkout set', () => {
  const { data, checkout } = developmentLayer();
  const home = tempDir('nep-no-development-home-');
  const file = 'neptunia-watcher.service';
  const text = unitText(
    {
      user: 'someone',
      group: 'someone',
      home,
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      node: '/usr/bin/node',
      developmentCheckout: checkout,
      system: true,
    },
    fs.readFileSync(path.join(REPO, 'deploy', file), 'utf8'),
    file
  );
  const lines = text.split('\n').filter((line) => !line.startsWith('#'));
  assert.deepEqual(
    lines.filter((line) => line.includes(checkout)),
    []
  );
  assert.deepEqual(
    lines.filter(
      (line) => line.startsWith('Environment=GH_CONFIG_DIR=') && line.includes(path.join(home, '.config', 'gh'))
    ),
    []
  );
});

// Bug: the evidence page still reads the development checkout (its branches, worktrees and stray files) or asks `gh`,
// though the watcher no longer answers for development.
test('the first evidence page runs no gh and no command on the checkout, with a checkout set', async () => {
  const { data, checkout } = developmentLayer();
  openMemoryDb(path.join(data, 'memory.db')).close();
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: (command, args) => {
        commands.push({ command, args });
        return Promise.resolve({ code: 1, stdout: '', stderr: 'unavailable here' });
      },
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok');
  assert.deepEqual(
    commands.filter(({ command }) => command === 'gh'),
    []
  );
  assert.deepEqual(
    commands.filter(({ args }) => args.some((arg) => arg.includes(checkout))),
    []
  );
});
