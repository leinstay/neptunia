// Tests for src/paths.js: the three directories of a deployment, from the two optional
// variables. Pure: every case passes its own env object, never the process environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePaths, PRIVATE_DIR_VAR, DATA_DIR_VAR } from '../src/paths.js';

const ROOT = path.resolve('/opt/engine');

test('resolvePaths: with neither variable set, the private directory is the root and data/ sits under it', () => {
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: {} }), {
    rootDir: ROOT,
    privateDir: ROOT,
    dataDir: path.join(ROOT, 'data'),
  });
});

test('resolvePaths: a blank variable counts as unset', () => {
  const paths = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: '', NEPTUNIA_DATA_DIR: '   ' } });
  assert.equal(paths.privateDir, ROOT);
  assert.equal(paths.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: absolute values are taken as they are', () => {
  const privateDir = path.resolve('/etc/engine-private');
  const dataDir = path.resolve('/var/lib/engine-data');
  assert.deepEqual(
    resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: privateDir, NEPTUNIA_DATA_DIR: dataDir } }),
    {
      rootDir: ROOT,
      privateDir,
      dataDir,
    }
  );
});

test('resolvePaths: relative values are resolved against the root, not the working directory', () => {
  const paths = resolvePaths({
    rootDir: ROOT,
    env: { NEPTUNIA_PRIVATE_DIR: '../private', NEPTUNIA_DATA_DIR: 'state/memory' },
  });
  assert.equal(paths.privateDir, path.resolve(ROOT, '..', 'private'));
  assert.equal(paths.dataDir, path.join(ROOT, 'state', 'memory'));
});

test('resolvePaths: a relative root comes back absolute, and each variable works alone', () => {
  const onlyData = resolvePaths({ rootDir: 'engine', env: { NEPTUNIA_DATA_DIR: 'mem' } });
  assert.equal(onlyData.rootDir, path.resolve('engine'));
  assert.equal(onlyData.privateDir, path.resolve('engine'));
  assert.equal(onlyData.dataDir, path.resolve('engine', 'mem'));
  const onlyPrivate = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: 'private' } });
  assert.equal(onlyPrivate.privateDir, path.join(ROOT, 'private'));
  assert.equal(onlyPrivate.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: the variable names are the documented ones', () => {
  assert.equal(PRIVATE_DIR_VAR, 'NEPTUNIA_PRIVATE_DIR');
  assert.equal(DATA_DIR_VAR, 'NEPTUNIA_DATA_DIR');
});
