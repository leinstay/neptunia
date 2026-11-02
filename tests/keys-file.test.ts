// src/keys/file.ts: the synchronous read and write of keys.json that the subharness, the simulation and setup
// share. A missing file is the empty store, a damaged one is refused without quoting its content, a write is mode 600
// and keeps the sections it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emptyKeys, hasExtraKey, readKeys, writeKeys } from '../src/keys/file.ts';
import { tempDir } from './fixtures/tmp.ts';

test('a folder with no keys.json reads as the empty store', () => {
  // Bug: a machine before setup crashes the first read with a file error.
  assert.deepEqual(readKeys(tempDir('nep-keysfile-')), emptyKeys());
});

test('a file that is no JSON is refused with a line that holds none of its content', () => {
  // Bug: the parse error quotes the file, which holds keys.
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), '{"extra": {"a": "sk-or-secret" ');
  assert.throws(
    () => readKeys(dir),
    (err: unknown) => err instanceof Error && !err.message.includes('sk-or-secret')
  );
});

test('a write is mode 600 and keeps a section it does not know', () => {
  // Bug: the file is written at the umask, or a section of another module is dropped on the next write.
  const dir = tempDir('nep-keysfile-');
  writeKeys(dir, { ...emptyKeys(), extra: { sim: 'v' }, ...{ futureSection: { kept: true } } });
  assert.equal(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777, 0o600);
  const again = readKeys(dir);
  assert.equal(Reflect.get(again, 'futureSection') !== undefined, true);
  assert.equal(hasExtraKey(again, 'sim'), true);
  assert.equal(hasExtraKey(again, 'constructor'), false);
});

test('a backend that is none of the three reads as off', () => {
  // Bug: a hand-edited backend name is passed on to a spawn.
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(
    path.join(dir, 'keys.json'),
    JSON.stringify({ subharness: { backend: 'rm', key: null, modes: {} } })
  );
  assert.equal(readKeys(dir).subharness.backend, null);
});

// Several subharnesses (spec 2026-11-02, PR 5): `subharness.backends` is the list of connected backends, and the old
// single `subharness.backend` of a store written before it reads as a one-element list.

const writeRaw = (subharness: Record<string, unknown>): string => {
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ subharness }));
  return dir;
};

test('a stored list of backends reads in its order, a repeat and an unknown name dropped', () => {
  // Catches: the list is sorted or deduplicated badly, so backends[0] (the default of an agent) is not the first one
  // connected, or a hand-edited name reaches a spawn.
  const dir = writeRaw({ backends: ['claude', 'rm', 'codex', 'claude'], key: null, modes: {} });
  assert.deepEqual(readKeys(dir).subharness.backends, ['claude', 'codex']);
});

test('the single backend of a store written before the list reads as a list of that one', () => {
  // Catches: a deployment that enabled codex before this change reads as off after the upgrade and every errand fails.
  const dir = writeRaw({ backend: 'codex', key: null, modes: {} });
  assert.deepEqual(readKeys(dir).subharness.backends, ['codex']);
});

test('an old single backend that is null or no backend reads as an empty list', () => {
  // Catches: `[null]` or `['rm']` is read as a connected backend and an agent run spawns it.
  assert.deepEqual(readKeys(writeRaw({ backend: null, key: null, modes: {} })).subharness.backends, []);
  assert.deepEqual(readKeys(writeRaw({ backend: 'rm', key: null, modes: {} })).subharness.backends, []);
});

test('the backend each agent runs through keeps only backend names', () => {
  // Catches: a hand-edited `uses` entry such as "sh" is passed to the run as a backend.
  const dir = writeRaw({ backends: ['codex'], uses: { watcher: 'claude', scout: 'sh' }, key: null, modes: {} });
  assert.deepEqual(readKeys(dir).subharness.uses, { watcher: 'claude' });
});

test('a write of the store leaves no single backend field beside the list', () => {
  // Catches: the old `backend` survives a write and a reader of the old shape keeps a backend the owner disabled.
  const dir = writeRaw({ backend: 'codex', key: null, modes: {} });
  writeKeys(dir, readKeys(dir));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')) as { subharness: object };
  assert.equal(Object.hasOwn(raw.subharness, 'backend'), false);
  assert.deepEqual(readKeys(dir).subharness.backends, ['codex']);
});
