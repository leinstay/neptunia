// Tests for src/memory/root.js: memoryRootOf maps a `data/` directory to the memory's paths,
// byte-identical to the joins the stores made by hand before it existed. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR, memoryRootOf } from '../src/memory/root.js';
import * as store from '../src/memory/store.js';

const dataDir = path.join(path.sep, 'srv', 'bot', 'data');
const root = memoryRootOf(dataDir);

test('memoryRootOf: keeps the data directory it was given', () => {
  assert.equal(root.dataDir, dataDir);
});

test('memoryRootOf: guild paths are the joins the stores made by hand', () => {
  assert.equal(root.guildsDir, path.join(dataDir, 'guilds'));
  assert.equal(root.guildDir('123'), path.join(dataDir, 'guilds', '123'));
  assert.equal(root.guildDir(123), path.join(dataDir, 'guilds', '123'));
});

test('memoryRootOf: the state file and the snapshots root sit at the top of data/', () => {
  assert.equal(root.stateFile, path.join(dataDir, 'state.json'));
  assert.equal(root.snapshotsRoot, path.join(dataDir, SNAPSHOTS_DIR));
  assert.equal(SNAPSHOTS_DIR, 'snapshots');
});

test('memoryRootOf: the record dir is the guild one unless a private member id is a non-empty string', () => {
  assert.equal(root.recordDir('123'), path.join(dataDir, 'guilds', '123', 'record'));
  assert.equal(root.recordDir('123', null), path.join(dataDir, 'guilds', '123', 'record'));
  assert.equal(root.recordDir('123', ''), path.join(dataDir, 'guilds', '123', 'record'));
  assert.equal(root.recordDir('123', 42), path.join(dataDir, 'guilds', '123', 'record'));
  assert.equal(root.recordDir('123', '42'), path.join(dataDir, 'guilds', '123', 'private', '42', 'record'));
});

test('memoryRootOf: the private dir, with or without a member', () => {
  assert.equal(root.privateDir('123'), path.join(dataDir, 'guilds', '123', 'private'));
  assert.equal(root.privateDir('123', null), path.join(dataDir, 'guilds', '123', 'private'));
  assert.equal(root.privateDir('123', ''), path.join(dataDir, 'guilds', '123', 'private'));
  assert.equal(root.privateDir('123', '42'), path.join(dataDir, 'guilds', '123', 'private', '42'));
  assert.equal(root.privateDir('123', 42), path.join(dataDir, 'guilds', '123', 'private', '42'));
});

test('memoryRootOf: the vault resolves under data/ by default and keeps an absolute path', () => {
  assert.equal(DEFAULT_VAULT_DIR, 'vault');
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
  assert.equal(rel.guildDir('1'), path.join('data', 'guilds', '1'));
  assert.equal(rel.stateFile, path.join('data', 'state.json'));
  assert.equal(rel.vaultDir(), path.resolve('data', 'vault'));
});

test('memoryRootOf: store.js still exports the vault and snapshot constants', () => {
  assert.equal(store.DEFAULT_VAULT_DIR, DEFAULT_VAULT_DIR);
  assert.equal(store.SNAPSHOTS_DIR, SNAPSHOTS_DIR);
});
