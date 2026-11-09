// Tests for src/memory/root.ts: memoryRootOf maps a `data/` directory to the memory's paths,
// byte-identical to the joins the stores made by hand before it existed. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SNAPSHOTS_DIR, memoryRootOf } from '../src/memory/root.ts';

const dataDir = path.join(path.sep, 'srv', 'bot', 'data');
const root = memoryRootOf(dataDir);

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

test('memoryRootOf: relative is forward-slash separated', () => {
  const abs = path.join(dataDir, 'guilds', '123', 'users', '42.json');
  assert.equal(root.relative(abs), 'guilds/123/users/42.json');
  assert.equal(root.relative(dataDir), '');
});

test('memoryRootOf: a relative data directory maps the same way', () => {
  const rel = memoryRootOf('data');
  assert.equal(rel.placeDir('1'), path.join('data', 'places', '1'));
  assert.equal(rel.stateFile, path.join('data', 'state.json'));
});
