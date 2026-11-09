// src/keys/file.ts: the synchronous read and write of keys.json that the subharness and setup
// share. A missing file is the empty store, a damaged one is refused without quoting its content, a write is mode 600
// and keeps the sections it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readRouting } from '../src/subharness/routing.ts';
import { emptyKeys, hasKey, readKeys, writeKeys } from '../src/keys/file.ts';
import { tempDir } from './fixtures/tmp.ts';

test('a folder with no keys.json reads as the empty store', () => {
  // Bug: a machine before setup crashes the first read with a file error.
  assert.deepEqual(readKeys(tempDir('nep-keysfile-')), emptyKeys());
});

test('a file that is no JSON is refused with a line that holds none of its content', () => {
  // Bug: the parse error quotes the file, which holds keys.
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), '{"keys": {"a": "sk-or-secret" ');
  assert.throws(
    () => readKeys(dir),
    (err: unknown) => err instanceof Error && !err.message.includes('sk-or-secret')
  );
});

test('a write is mode 600 and keeps a section it does not know', () => {
  // Bug: the file is written at the umask, or a section of another module is dropped on the next write.
  const dir = tempDir('nep-keysfile-');
  // Changed: keys.json holds named keys under `keys` (spec 2026-11-09-model-routes, slice 4).
  writeKeys(dir, { ...emptyKeys(), keys: { sim: 'v' }, ...{ futureSection: { kept: true } } });
  assert.equal(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777, 0o600);
  const again = readKeys(dir);
  assert.equal(Reflect.get(again, 'futureSection') !== undefined, true);
  assert.equal(hasKey(again, 'sim'), true);
  assert.equal(hasKey(again, 'constructor'), false);
});

test('a file that still holds the core list or the extra section is refused, with no value in the error', () => {
  // Catches: a keys.json the migration missed read as holding no key, so the subharness and the watcher run keyless.
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ extra: { helpers: 'sk-or-secret' } }));
  assert.throws(
    () => readKeys(dir),
    (err: unknown) => err instanceof Error && /core|extra/.test(err.message) && !err.message.includes('sk-or-secret')
  );
});

// Changed: the agents' backends live in config.json (src/subharness/routing.ts), so these read the routing there. The old
// `subharness.backends` list and single `subharness.backend` are no longer read at all: the deploy's one-off moved
// them into `models.agents.via` before the engine reads the new shape.

const writeRouting = (agents: Record<string, unknown>): string => {
  const dir = tempDir('nep-keysfile-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ models: { agents } }));
  return dir;
};

test('a backend that is none of the three reads as off', () => {
  // Bug: a hand-edited backend name is passed on to a spawn.
  assert.deepEqual(readRouting(writeRouting({ via: { dev: 'rm' } })).subharness.uses, {});
});

test('the backend each agent runs through keeps only backend names', () => {
  // Catches: a hand-edited `via` entry such as "sh" is passed to the run as a backend.
  const dir = writeRouting({ via: { watcher: 'claude', scout: 'sh' } });
  assert.deepEqual(readRouting(dir).subharness.uses, { watcher: 'claude' });
});

test('a write of the store leaves no routing section in keys.json', () => {
  // Catches: the old `subharness` survives a write, so keys.json keeps routing the engine no longer reads.
  // Changed: the routing sections leave keys.json whole, the old `backend` with them.
  const dir = tempDir('nep-keysfile-');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ subharness: { backend: 'codex' }, roles: {} }));
  writeKeys(dir, readKeys(dir));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')) as object;
  assert.equal(Object.hasOwn(raw, 'subharness'), false);
  assert.equal(Object.hasOwn(raw, 'roles'), false);
});
