// Tests for src/memory/root.ts: memoryRootOf maps a `data/` directory to the memory's paths,
// byte-identical to the joins the stores made by hand before it existed. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR, memoryRootOf } from '../src/memory/root.ts';
import * as store from '../src/memory/store.ts';

const dataDir = path.join(path.sep, 'srv', 'bot', 'data');
const root = memoryRootOf(dataDir);

test('memoryRootOf: keeps the data directory it was given', () => {
  assert.equal(root.dataDir, dataDir);
});

// The layout under `guilds/` is gone: a place's folder is named by its id, a DM's like any other, and the persona has its own.
test('memoryRootOf: the folder of a place is named by its id, and the persona has its own', () => {
  assert.equal(root.placeDir('discord:server:123'), path.join(dataDir, 'places', 'discord%3Aserver%3A123'));
  assert.equal(root.placeDir(null), path.join(dataDir, 'persona'));
});

test('memoryRootOf: the state file and the snapshots root sit at the top of data/', () => {
  assert.equal(root.stateFile, path.join(dataDir, 'state.json'));
  assert.equal(root.snapshotsRoot, path.join(dataDir, SNAPSHOTS_DIR));
  assert.equal(SNAPSHOTS_DIR, 'snapshots');
});

test('memoryRootOf: the vault resolves under data/ by default and keeps an absolute path', () => {
  assert.equal(DEFAULT_VAULT_DIR, 'vault');
  // @ts-expect-error no argument, on purpose: the vault falls back to its default
  assert.equal(root.vaultDir(), path.resolve(dataDir, 'vault'));
  assert.equal(root.vaultDir(''), path.resolve(dataDir, 'vault'));
  assert.equal(root.vaultDir('   '), path.resolve(dataDir, 'vault'));
  assert.equal(root.vaultDir(7), path.resolve(dataDir, 'vault'));
  assert.equal(root.vaultDir('keep'), path.resolve(dataDir, 'keep'));
  const absolute = path.join(path.sep, 'mnt', 'vault');
  assert.equal(root.vaultDir(absolute), path.resolve(absolute));
});

test('memoryRootOf: resolve is path.resolve against data/', () => {
  assert.equal(root.resolve('vault/copy-42-x'), path.resolve(dataDir, 'vault/copy-42-x'));
});

test('memoryRootOf: relative is forward-slash separated', () => {
  const abs = path.join(dataDir, 'guilds', '123', 'users', '42.json');
  assert.equal(root.relative(abs), 'guilds/123/users/42.json');
  assert.equal(root.relative(dataDir), '');
});

test('memoryRootOf: a relative data directory maps the same way', () => {
  const rel = memoryRootOf('data');
  assert.equal(rel.placeDir('1'), path.join('data', 'places', '1'));
  assert.equal(rel.stateFile, path.join('data', 'state.json'));
  // @ts-expect-error no argument, on purpose: the vault falls back to its default
  assert.equal(rel.vaultDir(), path.resolve('data', 'vault'));
});

test('memoryRootOf: store.js still exports the vault and snapshot constants', () => {
  assert.equal(store.DEFAULT_VAULT_DIR, DEFAULT_VAULT_DIR);
  assert.equal(store.SNAPSHOTS_DIR, SNAPSHOTS_DIR);
});
