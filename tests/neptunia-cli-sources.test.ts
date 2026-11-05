// PR 1, sources without an enable step: what only a real `neptunia` process proves about the account commands. They run
// with no core, stdout carries the result and stderr the reason, and the exit code says which: 0 logged in or done, 1 an
// operational answer. The vendor CLI and npm are fakes; PATH holds nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { cliFolders, runChild } from './fixtures/recording-core.ts';
import { tempDir } from './fixtures/tmp.ts';

/** PATH with a recording `npm` and nothing else; what a retired or a read command must never reach. */
function npmPath(): { env: NodeJS.ProcessEnv; npmCalls: () => string } {
  const bin = tempDir('nep-cli-path-');
  const log = path.join(bin, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n/bin/echo "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  return {
    env: { PATH: bin, HOME: tempDir('nep-cli-home-') },
    npmCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

test('neptunia subharness claude status answers on stdout with no core, exit 0 when logged in', async () => {
  // Catches: the account commands tied to a core socket, so a broken core cannot be repaired from a shell.
  const dirs = cliFolders();
  fakeVendor(dirs.privateDir, 'claude', { loggedIn: true });
  const { env } = npmPath();
  const logged = await runChild(dirs, ['subharness', 'claude', 'status'], { env });
  assert.equal(logged.code, 0, logged.stderr);
  assert.notEqual(logged.stdout, '');
  assert.equal(logged.stderr, '');
});

test('neptunia subharness codex login with no terminal and no install exits 1, names the need and installs nothing', async () => {
  // Catches: a hang on the install question, or a silent install from a script.
  const dirs = cliFolders();
  const { env, npmCalls } = npmPath();
  const run = await runChild(dirs, ['subharness', 'codex', 'login'], { env, open: true, ms: 8000 });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes('codex'), run.stderr);
  assert.ok(run.stderr.includes('install'), run.stderr);
  assert.equal(npmCalls(), '');
  assert.equal(fs.existsSync(path.join(dirs.privateDir, 'subharness', 'codex')), false);
});
