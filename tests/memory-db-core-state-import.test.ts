// Legacy core JSON imports through the public migration entry, real mappers and SQLite transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importCoreJsonState } from '../src/memory/db/core-state-import.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { buildDataDir, guildDir, GUILD, writeJson } from './fixtures/memory-db/datadir.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOTS = ['state.json', 'usage.json', 'metrics.json'];
const INNER = `guilds/${GUILD}/inner.json`;
const FILES = [
  ...ROOTS,
  ...['inner', 'missed', 'participation', 'gifs', 'media'].map((name) => `guilds/${GUILD}/${name}.json`),
];

function legacy() {
  const dataDir = tempDir('core-json-import-');
  buildDataDir(dataDir);
  writeJson(path.join(dataDir, 'usage.json'), { days: { '2026-11-03': { requests: 7, usd: 0.25 } } });
  writeJson(path.join(dataDir, 'metrics.json'), { turns: 4, calls: { read: 2 } });
  writeJson(path.join(guildDir(dataDir), 'missed.json'), { v: 1, pending: [{ id: 'synthetic-missed', at: 1234 }] });
  writeJson(path.join(guildDir(dataDir), 'gifs.json'), {
    nextId: 2,
    entries: { first: { url: 'https://example.invalid/a.gif', name: 'café', count: 3 } },
  });
  const sources = Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(path.join(dataDir, file), 'utf8')]));
  return { dataDir, sources, file: path.join(dataDir, 'memory.db') };
}

function stored(handle: MemoryHandle, owner: string): unknown {
  if (!ROOTS.includes(owner)) {
    const read = unitValue(dbOf(handle), owner);
    return read.found ? read.value : undefined;
  }
  const value = dbOf(handle)
    .prepare('SELECT value FROM operational WHERE kind = ? AND owner = ? AND owner_file IS NULL')
    .get(owner.replace('.json', ''), owner)?.value;
  return typeof value === 'string' ? JSON.parse(value) : undefined;
}

function rows(handle: MemoryHandle) {
  return Object.fromEntries(
    ['operational', 'files', 'media', 'episodes', 'episode_sources'].map((table) => [
      table,
      dbOf(handle).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])
  );
}

function unchanged(dataDir: string, sources: Record<string, string>): void {
  for (const [file, bytes] of Object.entries(sources))
    assert.equal(fs.readFileSync(path.join(dataDir, file), 'utf8'), bytes);
}

test('populated legacy state round-trips without losing root or guild values', () => {
  const fixture = legacy();
  const handle = openMemoryDb(fixture.file);
  try {
    assert.deepEqual(importCoreJsonState(handle, fixture), { imported: FILES.length });
    for (const [file, bytes] of Object.entries(fixture.sources))
      assert.deepEqual(stored(handle, file), JSON.parse(bytes));
    // SQLite rows have null prototypes. Paths express the marker identity without depending on row prototypes.
    assert.deepEqual(
      dbOf(handle)
        .prepare("SELECT path FROM files WHERE kind = 'core-state-import' ORDER BY path")
        .all()
        .map((row) => row.path),
      ROOTS.toSorted()
    );
    unchanged(fixture.dataDir, fixture.sources);
  } finally {
    handle.close();
  }
});

test('malformed legacy JSON refuses migration without changing existing database rows or sources', () => {
  const fixture = legacy();
  fs.writeFileSync(path.join(fixture.dataDir, 'metrics.json'), '{broken');
  fixture.sources['metrics.json'] = '{broken';
  const handle = openMemoryDb(fixture.file);
  try {
    applyUnitWrite(handle, { kind: 'unit', op: 'value', owner: INNER, value: { v: 1, stopped: true, queue: [] } });
    const before = rows(handle);
    assert.throws(() => importCoreJsonState(handle, fixture), { code: 'CORE_STATE_JSON' });
    assert.deepEqual(rows(handle), before);
    unchanged(fixture.dataDir, fixture.sources);
  } finally {
    handle.close();
  }
});

test('an empty installation imports zero files and creates no unit or import markers', () => {
  const dataDir = tempDir('core-json-empty-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    const before = rows(handle);
    assert.deepEqual(importCoreJsonState(handle, { dataDir }), { imported: 0 });
    assert.deepEqual(rows(handle), before);
  } finally {
    handle.close();
  }
});

test('an interrupted real SQLite write rolls back imported values and markers before a successful retry', () => {
  const fixture = legacy();
  const handle = openMemoryDb(fixture.file);
  try {
    const before = rows(handle);
    dbOf(handle).exec(`CREATE TRIGGER interrupt_core_import BEFORE INSERT ON operational
      WHEN (SELECT COUNT(*) FROM operational) > 0
      BEGIN SELECT RAISE(ABORT, 'synthetic import interruption'); END;`);
    assert.throws(() => importCoreJsonState(handle, fixture), /synthetic import interruption/);
    assert.deepEqual(rows(handle), before);
    unchanged(fixture.dataDir, fixture.sources);
    dbOf(handle).exec('DROP TRIGGER interrupt_core_import');
    assert.deepEqual(importCoreJsonState(handle, fixture), { imported: FILES.length });
    for (const [file, bytes] of Object.entries(fixture.sources))
      assert.deepEqual(stored(handle, file), JSON.parse(bytes));
  } finally {
    handle.close();
  }
});

test('reopening skips completed imports instead of duplicating rows or overwriting newer database state', () => {
  const fixture = legacy();
  let handle = openMemoryDb(fixture.file);
  try {
    assert.deepEqual(importCoreJsonState(handle, fixture), { imported: FILES.length });
    const current = { v: 1, stopped: true, queue: [] };
    applyUnitWrite(handle, { kind: 'unit', op: 'value', owner: INNER, value: current });
    dbOf(handle)
      .prepare("UPDATE operational SET value = ? WHERE kind = 'state' AND owner = 'state.json'")
      .run('{"paused":false}');
    const before = rows(handle);
    for (let opening = 0; opening < 2; opening += 1) {
      handle.close();
      handle = openMemoryDb(fixture.file);
      assert.deepEqual(importCoreJsonState(handle, fixture), { imported: 0 });
      assert.deepEqual(rows(handle), before);
      assert.deepEqual(stored(handle, INNER), current);
      assert.deepEqual(stored(handle, 'state.json'), { paused: false });
    }
  } finally {
    handle.close();
  }
});
