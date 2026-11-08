// src/setup/services.ts: the optional YouTube key of `neptunia setup`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceCredential } from '../src/keys/file.ts';
import { servicesStep } from '../src/setup/services.ts';
import { readLocalConfig } from '../src/tools/operations/shared.ts';
import { localConfigPath } from '../src/config/files.ts';
import { tempDir } from './fixtures/tmp.ts';

/** An `ask` that gives `answers` in order and an empty answer after them. */
const scripted = (answers: ReadonlyArray<string>) => {
  const rest = [...answers];
  return (): Promise<string> => Promise.resolve(rest.shift() ?? '');
};

const searchSettings = (dataDir: string): unknown =>
  (readLocalConfig(localConfigPath(dataDir)) as { web?: { quickSearch?: unknown } }).web?.quickSearch;

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

test('quick search stays off when the owner answers nothing, and no engine is written', async () => {
  // Bug: an install gets an engine by pressing enter through setup.
  const dataDir = tempDir('nep-setup-search-');
  assert.equal((await servicesStep({ dataDir }, { ask: scripted([]) })).state, 'already');
  assert.equal(searchSettings(dataDir), undefined);
});

test('a chosen engine goes in with what it needs, and without it the engine stays out', async () => {
  // Bug: the engine is written with an empty key or model, and quick search looks set up while it refuses every search.
  const given = tempDir('nep-setup-search-');
  await servicesStep({ dataDir: given }, { ask: scripted(['', 'openrouter', 'x/quick']) });
  assert.deepEqual(searchSettings(given), { model: 'x/quick', engine: 'openrouter' });
  const keyed = tempDir('nep-setup-search-');
  await servicesStep({ dataDir: keyed }, { ask: scripted(['', 'exa', 'exa-key']) });
  assert.deepEqual(searchSettings(keyed), { engine: 'exa' });
  assert.equal(serviceCredential(keyed, 'exa'), 'exa-key');
  const empty = tempDir('nep-setup-search-');
  await servicesStep({ dataDir: empty }, { ask: scripted(['', 'brave', '']) });
  assert.equal(searchSettings(empty), undefined);
});

test('an engine outside the three leaves quick search off', async () => {
  // Bug: a typo at the prompt is stored, and every later search fails with no-engine and nobody knows why.
  const dataDir = tempDir('nep-setup-search-');
  await servicesStep({ dataDir }, { ask: scripted(['', 'bing']) });
  assert.equal(searchSettings(dataDir), undefined);
});
