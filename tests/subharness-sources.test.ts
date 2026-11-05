// What `sourceState` (src/subharness/sources.ts) answers when the vendor's status command does not behave. The plain
// answers of availability are in tests/subharness-account.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { subharnessPlace } from '../src/subharness/place.ts';
import { availableSources, sourceState } from '../src/subharness/sources.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

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
