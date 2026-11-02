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
