// src/keys/card-keys.ts: where the owner's status card takes the management key from. Once keys.json exists it is the
// store's extra key `management` and `.env` has no say; without the store the `.env` variable serves. The store is a
// temp folder written as plain JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { statusCardKeys } from '../src/keys/card-keys.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ENV = { OPENROUTER_MANAGEMENT_KEY: 'v-env-mgmt-0002' };

test('with a key store the card reads the management key from it, never from .env', () => {
  // Catches: after keys-import the card keeps reading the old .env variable and shows a key the store no longer uses.
  const dir = tempDir('card-keys-');
  writeKeysFile(dir, { extra: { management: 'v-store-mgmt-0004' } });
  assert.deepEqual(statusCardKeys(dir, ENV), { managementKey: 'v-store-mgmt-0004' });
});

test('with a key store that holds no management key the card has none, whatever .env still holds', () => {
  // Catches: a store without a management key falls back to the .env variable and the card spends a key the owner removed.
  const dir = tempDir('card-keys-');
  writeKeysFile(dir, { extra: { other: 'v-store-other-0003' } });
  assert.deepEqual(statusCardKeys(dir, ENV), { managementKey: null });
});

test('without a key store the card reads the .env variable, and a blank one is none', () => {
  // Catches: a deployment that has not run the import loses its card statistics before the deploy.
  const dir = tempDir('card-keys-');
  assert.deepEqual(statusCardKeys(dir, ENV), { managementKey: 'v-env-mgmt-0002' });
  assert.deepEqual(statusCardKeys(dir, { OPENROUTER_MANAGEMENT_KEY: ' ' }), { managementKey: null });
});

test('a key store that does not parse gives no key and does not throw', () => {
  // Catches: a broken keys.json takes the whole status card down with it.
  const dir = tempDir('card-keys-');
  fs.writeFileSync(keysPath(dir), '{ not json', { mode: 0o600 });
  assert.deepEqual(statusCardKeys(dir, ENV), { managementKey: null });
});
