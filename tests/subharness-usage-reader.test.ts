// The reader the console holds (src/subharness/usage.ts#backendUsageReader): each read is compared with what the last one
// showed, per source. The provider is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendUsageReader } from '../src/subharness/usage.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

test('a read that fails after one that worked shows the old numbers as stale, and a later success replaces them', async () => {
  // Catches: the reconciler never fed its previous observation, so a brief outage blanks the view.
  const privateDir = tempDir('nep-usage-reader-');
  writeKeysFile(privateDir);
  const statuses = [200, 500, 200];
  const read = backendUsageReader(() => ({
    privateDir,
    now: () => 1000,
    baseUrl: 'https://openrouter.test/api/v1',
    openRouterKey: { name: 'core one', value: 'value' },
    fetch: () =>
      Promise.resolve(new Response(JSON.stringify({ data: { usage: 3 } }), { status: statuses.shift() ?? 500 })),
    spawn: () => {
      throw new Error('no child in this test');
    },
    exec: () => Promise.reject(new Error('no command in this test')),
  }));
  const usageOf = async () => {
    const found = (await read()).find((one) => one.source === 'openrouter');
    return found?.metrics.find((one) => one.name === 'usage');
  };
  assert.equal((await usageOf())?.state, 'observed');
  const failed = await usageOf();
  assert.equal(failed?.state, 'stale');
  assert.equal(failed?.value, 3);
  assert.equal((await usageOf())?.state, 'observed');
});
