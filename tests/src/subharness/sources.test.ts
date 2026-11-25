// What `sourceState` (src/subharness/sources.ts) answers: a subharness is available when it is installed and
// authenticated, and a vendor status command that does not behave reads as not logged in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { availableSources, sourceState } from '../../../src/subharness/sources.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import path from 'node:path';
import type { AccountDeps } from '../../../src/subharness/account.ts';
import type { FakeVendor, FakeVendorOptions } from '../../fixtures/fake-vendor.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';

const HOST_ENV = { PATH: '/usr/bin:/bin' };

type Rig = { privateDir: string; vendor: FakeVendor; deps: AccountDeps; asked: Array<string> };

/**
 * A private layer with a fake of `backend`. `answers` are what the owner says, in order; null means nobody can answer,
 * the case of a process with no terminal.
 */
function rig(backend: 'codex' | 'claude', options: FakeVendorOptions = {}, answers: Array<string> | null = []): Rig {
  const privateDir = tempDir('nep-account-');
  writeKeysFile(privateDir, {
    subharness: {
      key: null,
      modes: { server: 'full' },
      models: { server: 'sonnet' },
      uses: { server: 'claude', scout: 'codex' },
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const vendor = fakeVendor(privateDir, backend, options);
  const asked: Array<string> = [];
  const deps: AccountDeps = {
    privateDir,
    hostEnv: HOST_ENV,
    install: vendor.install,
    loginStdio: 'ignore',
    ask:
      answers === null
        ? null
        : (question) => {
            asked.push(question);
            return Promise.resolve(answers.shift() ?? '');
          },
  };
  return { privateDir, vendor, deps, asked };
}

// Availability

test('a source is available when it is installed and its own status command says it is logged in', async () => {
  // Catches: availability read from a stored flag, or from the installing user's home instead of the backend's own.
  const { privateDir, vendor } = rig('claude', { loggedIn: true });
  assert.deepEqual(await sourceState(privateDir, 'claude'), {
    backend: 'claude',
    installed: true,
    authenticated: true,
    available: true,
    code: 'ok',
  });
  assert.deepEqual(vendor.calls(), ['auth status']);
  assert.deepEqual(vendor.homes(), [vendor.home]);
});

test('codex is asked with login status under its own home', async () => {
  // Catches: one status argv for both vendors; `codex auth status` would be a model prompt or an error.
  const { privateDir, vendor } = rig('codex', { loggedIn: true });
  assert.equal((await sourceState(privateDir, 'codex')).available, true);
  assert.deepEqual(vendor.calls(), ['login status']);
  assert.deepEqual(vendor.homes(), [vendor.home]);
});

test('an installed source with no login and a source with no binary are told apart, and neither is available', async () => {
  // Catches: one "unavailable" answer, so the owner is told to log in to a backend that is not there.
  const out = rig('claude');
  const state = await sourceState(out.privateDir, 'claude');
  assert.equal(state.code, 'not-logged-in');
  assert.equal(state.installed, true);
  assert.equal(state.available, false);
  const absent = await sourceState(out.privateDir, 'codex');
  assert.equal(absent.code, 'not-installed');
  assert.equal(absent.authenticated, false);
  assert.equal(absent.available, false);
});

test('opencode is authenticated by an extra key the store still holds, with no process', async () => {
  // Catches: a key name that left the store still counts as a login, and every run then fails with no key.
  const privateDir = tempDir('nep-account-');
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  writeKeysFile(privateDir, { extra: { 'oc-1': 'value' }, subharness: { key: 'oc-1', modes: {} } });
  assert.equal((await sourceState(privateDir, 'opencode')).available, true);
  writeKeysFile(privateDir, { extra: {}, subharness: { key: 'oc-1', modes: {} } });
  assert.equal((await sourceState(privateDir, 'opencode')).code, 'not-logged-in');
});

test('a binary that crashes on its status reads as not logged in and does not reject', async () => {
  // Catches: one broken CLI rejects the read, and /subharness status and the doctor fail for every other source.
  const privateDir = tempDir('nep-sources-');
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fs.writeFileSync(subharnessPlace(privateDir, 'claude').binary, '#!/nonexistent/interpreter\n', { mode: 0o755 });
  assert.equal((await sourceState(privateDir, 'claude')).code, 'not-logged-in');
  assert.deepEqual(await availableSources(privateDir), []);
});

test('a private layer with nothing in it has no source and creates nothing', async () => {
  // Catches: a read that leaves a folder behind, which the next look takes for a half-installed backend.
  const privateDir = tempDir('nep-sources-');
  assert.deepEqual(await availableSources(privateDir), []);
  assert.deepEqual(fs.readdirSync(privateDir), []);
});
