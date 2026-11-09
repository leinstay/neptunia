// Runtime privateDir names the selected persona data directory. Each case injects its own environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePaths } from '../src/paths.ts';

const ROOT = path.resolve('/opt/engine');

test('resolvePaths: with neither variable set, personal material lives in root/data', () => {
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: {} }), {
    rootDir: ROOT,
    privateDir: path.join(ROOT, 'data'),
    dataDir: path.join(ROOT, 'data'),
  });
});

test('resolvePaths: a blank variable counts as unset', () => {
  const paths = resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_DATA_DIR: '   ' } });
  assert.equal(paths.privateDir, path.join(ROOT, 'data'));
  assert.equal(paths.dataDir, path.join(ROOT, 'data'));
});

test('resolvePaths: absolute values are taken as they are', () => {
  const dataDir = path.resolve('/var/lib/engine-data');
  assert.deepEqual(resolvePaths({ rootDir: ROOT, env: { NEPTUNIA_DATA_DIR: dataDir } }), {
    rootDir: ROOT,
    privateDir: dataDir,
    dataDir,
  });
});

test('resolvePaths: relative values are resolved against the root, not the working directory', () => {
  const paths = resolvePaths({
    rootDir: ROOT,
    env: { NEPTUNIA_DATA_DIR: 'state/memory' },
  });
  assert.equal(paths.privateDir, path.join(ROOT, 'state', 'memory'));
  assert.equal(paths.dataDir, path.join(ROOT, 'state', 'memory'));
});

test('resolvePaths: a relative root comes back absolute', () => {
  const onlyData = resolvePaths({ rootDir: 'engine', env: { NEPTUNIA_DATA_DIR: 'mem' } });
  assert.equal(onlyData.rootDir, path.resolve('engine'));
  assert.equal(onlyData.privateDir, path.resolve('engine', 'mem'));
  assert.equal(onlyData.dataDir, path.resolve('engine', 'mem'));
});
