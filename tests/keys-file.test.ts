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
  // Changed: the store holds what each agent uses, and off is no entry.
  assert.deepEqual(readKeys(dir).subharness.uses, {});
});

// A stored `subharness.backends`, and the old single `subharness.backend` before it, migrate at read time into the
// `uses` entry of every agent that named no backend. The first valid name is what those agents ran through.

const writeRaw = (subharness: Record<string, unknown>): string => {
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ subharness }));
  return dir;
};

test('a stored list becomes the uses of the agents, its first valid name, an unknown name dropped', () => {
  // Catches: the list is sorted badly, so an agent moves off the backend it ran through, or a hand-edited name reaches a
  // spawn.
  // Changed: the list is read into `uses`, not kept.
  const dir = writeRaw({ backends: ['rm', 'claude', 'codex', 'claude'], key: null, modes: {} });
  assert.equal(readKeys(dir).subharness.uses.dev, 'claude');
});

test('the single backend of a store written before the list migrates the same way', () => {
  // Catches: a deployment that enabled codex before this change reads as off after the upgrade and every errand fails.
  // Changed: the list is read into `uses`, not kept.
  const dir = writeRaw({ backend: 'codex', key: null, modes: {} });
  assert.equal(readKeys(dir).subharness.uses.dev, 'codex');
});

test('an old single backend that is null or no backend assigns nothing', () => {
  // Catches: `[null]` or `['rm']` is read as a backend and an agent run spawns it.
  // Changed: the list is read into `uses`, not kept.
  assert.deepEqual(readKeys(writeRaw({ backend: null, key: null, modes: {} })).subharness.uses, {});
  assert.deepEqual(readKeys(writeRaw({ backend: 'rm', key: null, modes: {} })).subharness.uses, {});
});

test('the backend each agent runs through keeps only backend names', () => {
  // Catches: a hand-edited `uses` entry such as "sh" is passed to the run as a backend.
  // Changed: no list in the seed, which would assign the other agents.
  const dir = writeRaw({ uses: { watcher: 'claude', scout: 'sh' }, key: null, modes: {} });
  assert.deepEqual(readKeys(dir).subharness.uses, { watcher: 'claude' });
});

test('a write of the store leaves neither the single backend nor the list', () => {
  // Catches: the old `backend` survives a write and a reader of the old shape keeps a backend the owner disabled.
  // Changed: the list is gone from the store too, its choice kept in `uses`.
  const dir = writeRaw({ backend: 'codex', key: null, modes: {} });
  writeKeys(dir, readKeys(dir));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')) as { subharness: object };
  assert.equal(Object.hasOwn(raw.subharness, 'backend'), false);
  assert.equal(Object.hasOwn(raw.subharness, 'backends'), false);
  assert.equal(readKeys(dir).subharness.uses.dev, 'codex');
});
