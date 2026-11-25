// Tests for src/compile-cache.ts: which folder the commands' compile cache is named in the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { useCompileCache } from '../../src/compile-cache.ts';

const scratch = path.join(process.env.TMPDIR ?? '/tmp', 'compile-cache-test');

test('useCompileCache: names the folder under XDG_CACHE_HOME when that is set', () => {
  const env: NodeJS.ProcessEnv = { XDG_CACHE_HOME: path.join(scratch, 'xdg') };
  useCompileCache(env, path.join(scratch, 'home'));
  assert.equal(env.NODE_COMPILE_CACHE, path.join(scratch, 'xdg', 'neptunia-compile'));
});

test('useCompileCache: names the folder under the home .cache when XDG_CACHE_HOME is empty', () => {
  const env: NodeJS.ProcessEnv = { XDG_CACHE_HOME: '' };
  useCompileCache(env, path.join(scratch, 'home'));
  assert.equal(env.NODE_COMPILE_CACHE, path.join(scratch, 'home', '.cache', 'neptunia-compile'));
});

test('useCompileCache: keeps a cache a unit named already', () => {
  const named = path.join(scratch, 'unit-cache');
  const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: named, XDG_CACHE_HOME: path.join(scratch, 'xdg') };
  useCompileCache(env, path.join(scratch, 'home'));
  assert.equal(env.NODE_COMPILE_CACHE, named);
});

test('useCompileCache: replaces an empty NODE_COMPILE_CACHE with the shared folder', () => {
  const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: '' };
  useCompileCache(env, path.join(scratch, 'home'));
  assert.equal(env.NODE_COMPILE_CACHE, path.join(scratch, 'home', '.cache', 'neptunia-compile'));
});
