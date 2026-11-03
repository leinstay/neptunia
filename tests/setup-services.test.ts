// src/setup/services.ts: the optional YouTube key of `neptunia setup`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceCredential } from '../src/keys/file.ts';
import { servicesStep } from '../src/setup/services.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the step shows the link, takes the key without echo, and an empty answer skips it', async () => {
  // Bug: the owner is asked for a key with no way to learn where it comes from, or the key is echoed.
  const dataDir = tempDir('nep-setup-services-');
  const asked: Array<{ question: string; secret: boolean }> = [];
  const ask = (answer: string) => (question: string, _offered: string | null, options?: { secret: boolean }) => {
    asked.push({ question, secret: options?.secret === true });
    return Promise.resolve(answer);
  };
  assert.equal((await servicesStep({ dataDir }, { ask: ask('') })).state, 'already');
  assert.equal(serviceCredential(dataDir, 'youtube'), null);
  assert.equal((await servicesStep({ dataDir }, { ask: ask('AIzaKEY') })).state, 'done');
  assert.equal(serviceCredential(dataDir, 'youtube'), 'AIzaKEY');
  assert.match(asked[0]?.question ?? '', /developers\.google\.com\/youtube/);
  assert.equal(asked[0]?.secret, true);
});
