// The table-level restore of tools/memory-db.mjs (`restore-tables`): the board and her memory share one file, and
// each comes back from a backup alone. A board-only restore leaves every memory table as it was, row for row and hash
// for hash, and a memory-only restore leaves the board so. Each case changes both parts after the backup, so a restore
// that copied the whole file, or the wrong part, shows as a hash that moved. Synthetic data, temporary directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { main, tableHashes } from '../tools/memory-db.mjs';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings } from '../src/board/board.ts';
import { BOARD_MIGRATIONS } from '../src/board/schema.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { buildDataDir } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

type Hash = { table: string; rows: number; hash: string };
type Handle = { db: object; close: () => void };

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

const isBoard = (table: string): boolean => table.startsWith('board_');

function hashesOf(file: string): Array<Hash> {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return tableHashes(handle.db);
  } finally {
    handle.close();
  }
}

const boardPart = (hashes: Array<Hash>): Array<Hash> => hashes.filter((entry) => isBoard(entry.table));
const memoryPart = (hashes: Array<Hash>): Array<Hash> => hashes.filter((entry) => !isBoard(entry.table));

function run(...argv: Array<string>): { code: unknown; text: string } {
  const lines: Array<string> = [];
  const code: unknown = main(argv, {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  });
  return { code, text: lines.join('\n') };
}

/** Opens the memory file and its board, runs `fn`, closes. */
function withBoard(
  env: Env,
  fn: (board: Board, handle: Handle) => void,
  boardMigrations?: ReadonlyArray<string>
): void {
  const handle = boardMigrations ? openMemoryDb(env.file, { boardMigrations }) : openMemoryDb(env.file);
  try {
    fn(openBoard({ db: dbOf(handle), privateDir: env.root, now: () => NOW, settings: () => SETTINGS }), handle);
  } finally {
    handle.close();
  }
}

type Env = { root: string; file: string; backup: string };

/** A seeded memory file with two board tasks, and a backup of it. */
function seeded(): Env {
  const root = tempDir('nep-board-restore-');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  fs.writeFileSync(
    path.join(root, 'clients.json'),
    JSON.stringify({ boss: { kind: 'cli', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] } })
  );
  const env = { root, file: path.join(data, 'memory.db'), backup: path.join(root, 'backup') };
  const handle = openMemoryDb(env.file);
  try {
    assert.equal(seedUnits(handle, data, { now: () => NOW }).errors, 0);
  } finally {
    handle.close();
  }
  withBoard(env, (board) => {
    const first = board.call('boss', 'task.add', { title: 'in the backup' });
    board.call('boss', 'task.comment', { id: first.id, text: 'a comment in the backup' });
    board.call('boss', 'task.add', { title: 'also in the backup' });
  });
  const backup = run('backup', '--db', env.file, '--to', env.backup);
  assert.equal(backup.code, 0, backup.text);
  return env;
}

/** Changes both parts after the backup: a board task and a comment, a memory row. */
function changeBoth(env: Env): void {
  withBoard(env, (board, handle) => {
    const later = board.call('boss', 'task.add', { title: 'after the backup' });
    board.call('boss', 'task.comment', { id: later.id, text: 'a comment after the backup' });
    dbOf(handle).prepare("INSERT INTO meta (key, value) VALUES ('after-backup', 'Ωμέγα')").run();
  });
}

test('a board-only restore brings the board back from the backup and leaves every memory table as it was', () => {
  const env = seeded();
  const backup = hashesOf(path.join(env.backup, 'memory.db'));
  changeBoth(env);
  const before = hashesOf(env.file);
  assert.notDeepEqual(boardPart(before), boardPart(backup), 'the fixture changed the board after the backup');
  assert.notDeepEqual(memoryPart(before), memoryPart(backup), 'the fixture changed the memory after the backup');

  const restored = run('restore-tables', '--part', 'board', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 0, restored.text);

  const after = hashesOf(env.file);
  assert.deepEqual(memoryPart(after), memoryPart(before));
  assert.deepEqual(boardPart(after), boardPart(backup));
});

test('a memory-only restore brings her memory back from the backup and leaves every board table as it was', () => {
  const env = seeded();
  const backup = hashesOf(path.join(env.backup, 'memory.db'));
  changeBoth(env);
  const before = hashesOf(env.file);

  const restored = run('restore-tables', '--part', 'memory', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 0, restored.text);

  const after = hashesOf(env.file);
  assert.deepEqual(boardPart(after), boardPart(before));
  assert.deepEqual(memoryPart(after), memoryPart(backup));
});

test('a board-only restore between two board versions is refused and changes nothing', () => {
  const env = seeded();
  withBoard(env, () => {}, [...BOARD_MIGRATIONS, 'CREATE TABLE board_later (id TEXT PRIMARY KEY);']);
  const before = hashesOf(env.file);

  const restored = run('restore-tables', '--part', 'board', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 2, restored.text);
  assert.deepEqual(hashesOf(env.file), before);
});

test('a memory-only restore between two memory versions is refused and changes nothing', () => {
  const env = seeded();
  const older = path.join(env.root, 'older');
  fs.mkdirSync(older);
  const file = path.join(older, 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 20) }).close();
  const before = hashesOf(file);

  const restored = run('restore-tables', '--part', 'memory', '--from', env.backup, '--db', file);
  assert.equal(restored.code, 2, restored.text);
  assert.deepEqual(hashesOf(file), before);
});

test('a restore is refused while a live process holds the writer lock, and changes nothing', () => {
  const env = seeded();
  changeBoth(env);
  const before = hashesOf(env.file);
  fs.writeFileSync(`${env.file}.lock`, JSON.stringify({ pid: process.pid, startedAt: new Date(NOW).toISOString() }));

  const restored = run('restore-tables', '--part', 'board', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 2, restored.text);
  fs.rmSync(`${env.file}.lock`);
  assert.deepEqual(hashesOf(env.file), before);
});

test('a restore from a backup that fails its manifest is refused and changes nothing', () => {
  const env = seeded();
  changeBoth(env);
  const before = hashesOf(env.file);
  fs.appendFileSync(path.join(env.backup, 'memory.db'), Buffer.from([0]));

  const restored = run('restore-tables', '--part', 'board', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 2, restored.text);
  assert.deepEqual(hashesOf(env.file), before);
});

test('a restore of a part that is neither board nor memory is a usage error and changes nothing', () => {
  const env = seeded();
  const before = hashesOf(env.file);

  const restored = run('restore-tables', '--part', 'all', '--from', env.backup, '--db', env.file);
  assert.equal(restored.code, 2, restored.text);
  assert.deepEqual(hashesOf(env.file), before);
});
