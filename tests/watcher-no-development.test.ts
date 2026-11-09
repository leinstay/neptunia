// The watcher holds no development role (the owner's word of 2026-11-06): with every condition of the old development
// mode met, `selfimprovement.checkout` naming a checkout among them, its first evidence page runs no `gh` and no command
// on the checkout. The watcher's unit is gone (owner, 2026-11-09), and tests/watcher-doctor.test.ts holds that the
// worker the core starts gets no gh login. No systemd is touched; folders are temporary ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { serviceFamily } from '../src/service/commands.ts';
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
