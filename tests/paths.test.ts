// Runtime privateDir aliases the selected persona data directory. Each case injects its own environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePaths, PRIVATE_DIR_VAR, DATA_DIR_VAR } from '../src/paths.ts';

const ROOT = path.resolve('/opt/engine');

test('resolvePaths: with neither variable set, personal material lives in root/data', () => {
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: {} }), {
    rootDir: ROOT,
    privateDir: path.join(ROOT, 'data'),
    dataDir: path.join(ROOT, 'data'),
  });
});

test('resolvePaths: a blank variable counts as unset', () => {
  const paths = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: '', NEPTUNIA_DATA_DIR: '   ' } });
  assert.equal(paths.privateDir, path.join(ROOT, 'data'));
  assert.equal(paths.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: absolute values are taken as they are', () => {
  const dataDir = path.resolve('/var/lib/engine-data');
  assert.deepEqual(
    resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: dataDir, NEPTUNIA_DATA_DIR: dataDir } }),
    {
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
    }
  );
});

test('resolvePaths: relative values are resolved against the root, not the working directory', () => {
  const paths = resolvePaths({
    rootDir: ROOT,
    env: { NEPTUNIA_PRIVATE_DIR: 'state/memory', NEPTUNIA_DATA_DIR: 'state/memory' },
  });
  assert.equal(paths.privateDir, path.join(ROOT, 'state', 'memory'));
  assert.equal(paths.dataDir, path.join(ROOT, 'state', 'memory'));
});

test('resolvePaths: a relative root comes back absolute, and each variable works alone', () => {
  const onlyData = resolvePaths({ rootDir: 'engine', env: { NEPTUNIA_DATA_DIR: 'mem' } });
  assert.equal(onlyData.rootDir, path.resolve('engine'));
  assert.equal(onlyData.privateDir, path.resolve('engine', 'mem'));
  assert.equal(onlyData.dataDir, path.resolve('engine', 'mem'));
  const onlyPrivate = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_PRIVATE_DIR: 'data' } });
  assert.equal(onlyPrivate.privateDir, path.join(ROOT, 'data'));
  assert.equal(onlyPrivate.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: the variable names are the documented ones', () => {
  assert.equal(PRIVATE_DIR_VAR, 'NEPTUNIA_PRIVATE_DIR');
  assert.equal(DATA_DIR_VAR, 'NEPTUNIA_DATA_DIR');
});
