// The backends of src/agent-runner/backend.ts as installed in her private layer (spec 2026-11-02, PR 5, "Where a
// subharness lives"): `createInstalledBackend` starts the binary of `<private>/subharness/<backend>/` with that
// folder's home in the environment, and refuses with `not-installed` when the folder holds no binary, whatever is on
// PATH. The installed binary is a link to the stub tests/fixtures/fake-cli.ts, which reports its environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInstalledBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

/** Puts the stub where `backend` is installed in `privateDir`. */
function install(privateDir: string, backend: BackendName): void {
  const { binary } = subharnessPlace(privateDir, backend);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.symlinkSync(STUB, binary);
}

test('a backend that is not in her folder is refused not-installed and nothing is spawned, though PATH has one', async () => {
  // Catches: the run falls back to the claude of the user's own ~/.local/bin, logged in to his account, not hers.
  const privateDir = tempDir('nep-installed-');
  const userBin = tempDir('nep-user-bin-');
  fs.writeFileSync(path.join(userBin, 'claude'), '#!/bin/sh\necho from-the-user\n', { mode: 0o755 });
  fs.chmodSync(path.join(userBin, 'claude'), 0o755);
  let spawned = 0;
  const counting = ((...args: Parameters<typeof spawn>) => {
    spawned += 1;
    return spawn(...args);
  }) as typeof spawn; // the counter forwards every argument to the real spawn unchanged
  const { dir, cleanup } = scratch();
  try {
    const result = await createInstalledBackend('claude', privateDir, { spawnImpl: counting }).run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { PATH: `${userBin}:${process.env.PATH ?? ''}` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not-installed');
    assert.equal(result.exitCode, null);
    assert.equal(result.text, '');
    assert.equal(spawned, 0);
  } finally {
    cleanup();
  }
});

test('each installed backend runs from her folder with its home in the environment', async () => {
  // Catches: the binary runs with the user's HOME alone, so codex reads ~/.codex, claude ~/.claude and OpenCode ~/.config.
  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    const privateDir = tempDir('nep-installed-');
    install(privateDir, backend);
    const { dir, cleanup } = scratch();
    try {
      const result = await createInstalledBackend(backend, privateDir).run('hello', {
        cwd: dir,
        timeoutMs: 20_000,
        env: { FAKE_MODE: 'report' },
      });
      assert.equal(result.ok, true, backend);
      const seen = reportOf(result.text).env;
      for (const [name, value] of Object.entries(subharnessPlace(privateDir, backend).env))
        assert.equal(seen[name], value, `${backend} ${name}`);
    } finally {
      cleanup();
    }
  }
});

test("her home wins over a home the caller passes, so a run never reaches the user's ~/.codex", async () => {
  // Catches: options.env is laid over the place's environment and a caller's CODEX_HOME=~/.codex points codex home.
  const privateDir = tempDir('nep-installed-');
  install(privateDir, 'codex');
  const { dir, cleanup } = scratch();
  try {
    const result = await createInstalledBackend('codex', privateDir).run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_MODE: 'report', CODEX_HOME: '/home/alice/.codex' },
    });
    assert.equal(reportOf(result.text).env.CODEX_HOME, subharnessPlace(privateDir, 'codex').env.CODEX_HOME);
  } finally {
    cleanup();
  }
});
