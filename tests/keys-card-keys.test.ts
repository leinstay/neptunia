// src/keys/card-keys.ts: where the owner's status card takes the management key from. Once keys.json exists it is the
// store's extra key `management`, and without it the card has none. The store is a temp folder written as plain JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { statusCardKeys } from '../src/keys/card-keys.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

test('with a key store the card reads the management key from it', () => {
  // Catches: the card reading its management key from anywhere but the store.
  const dir = tempDir('card-keys-');
  writeKeysFile(dir, { extra: { management: 'v-store-mgmt-0004' } });
  assert.deepEqual(statusCardKeys(dir), { managementKey: 'v-store-mgmt-0004' });
});

test('with a key store that holds no management key the card has none, whatever .env still holds', () => {
  // Catches: a store without a management key still gives the card one and it spends a key the owner removed.
  const dir = tempDir('card-keys-');
  writeKeysFile(dir, { extra: { other: 'v-store-other-0003' } });
  assert.deepEqual(statusCardKeys(dir), { managementKey: null });
});

test('without a key store the card has no management key', () => {
  // Catches: a deployment with no keys.json still reads a management key from somewhere and the card spends it.
  assert.deepEqual(statusCardKeys(tempDir('card-keys-')), { managementKey: null });
});

test('a key store that does not parse gives no key and does not throw', () => {
  // Catches: a broken keys.json takes the whole status card down with it.
  const dir = tempDir('card-keys-');
  fs.writeFileSync(keysPath(dir), '{ not json', { mode: 0o600 });
  assert.deepEqual(statusCardKeys(dir), { managementKey: null });
});
