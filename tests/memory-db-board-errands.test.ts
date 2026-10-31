// tools/memory-db.mjs over a database whose errands board v3 moved out of the `work` archive (PR 6d):
// `board verify-errands` compares every archived errand with its board task, field by field, and names the errand
// and the field that differ; `restore-tables --part memory` brings the archive back from a backup and leaves its
// guards on. The archive comes from fixtures/errand-archive.ts. Temporary directories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { main, tableHashes } from '../tools/memory-db.mjs';
import type { BoardDb } from '../src/board/schema.ts';
import { ARCHIVE, archiveDataDir } from './fixtures/errand-archive.ts';

type Verdict = { checked: number; mismatches: Array<{ id: string; field: string }> };
type Hash = { table: string; rows: number; hash: string };

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

function run(...argv: Array<string>): { code: unknown; out: Array<string>; err: Array<string> } {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code: unknown = main(argv, { out: (line: string) => out.push(line), err: (line: string) => err.push(line) });
  return { code, out, err };
}

/** The archive opened once by the current code (board v3 runs), then `change` on the open file. */
function moved(change: (db: BoardDb) => void = () => {}): { dataDir: string; file: string } {
  const env = archiveDataDir('nep-verify-errands-');
  const handle = openMemoryDb(env.file);
  try {
    change(dbOf(handle));
  } finally {
    handle.close();
  }
  return env;
}

function verify(file: string): { code: unknown; verdict: Verdict } {
  const result = run('board', 'verify-errands', '--db', file, '--json');
  assert.equal(result.out.length, 1, result.err.join('\n'));
  // --json prints one line, the verdict (see the brief).
  return { code: result.code, verdict: JSON.parse(result.out[0] ?? 'null') as Verdict };
}

test('verify-errands is clean after the move and counts every archived errand', () => {
  const { file } = moved();
  const { code, verdict } = verify(file);
  assert.equal(code, 0);
  assert.deepEqual(verdict, { checked: ARCHIVE.length, mismatches: [] });
});

test('verify-errands names the errand and the field whose board task was altered after the move', () => {
  const { file } = moved((db) => {
    db.prepare("UPDATE board_tasks SET status = 'failed' WHERE id = 't0000e001'").run();
  });
  const { code, verdict } = verify(file);
  assert.equal(code, 1);
  assert.deepEqual(verdict.mismatches, [{ id: 't0000e001', field: 'state' }]);
});

test('verify-errands reports an archived errand the board holds no task for as missing', () => {
  const { file } = moved((db) => {
    db.prepare("DELETE FROM board_tasks WHERE id = 't0000e002'").run();
  });
  const { code, verdict } = verify(file);
  assert.equal(code, 1);
  assert.deepEqual(verdict.mismatches, [{ id: 't0000e002', field: 'missing' }]);
});

test('a memory-only restore brings the archive back from the backup and leaves it refusing writes', () => {
  const { dataDir, file } = moved();
  const backup = path.join(path.dirname(dataDir), 'backup');
  const made = run('backup', '--db', file, '--to', backup);
  assert.equal(made.code, 0, made.err.join('\n'));
  const memoryOf = (hashes: Array<Hash>): Array<Hash> => hashes.filter((entry) => !entry.table.startsWith('board_'));
  const read = (target: string): Array<Hash> => {
    const handle = openMemoryDb(target, { readOnly: true });
    try {
      return tableHashes(handle.db);
    } finally {
      handle.close();
    }
  };
  const fromBackup = memoryOf(read(path.join(backup, 'memory.db')));
  const handle = openMemoryDb(file);
  try {
    dbOf(handle).prepare("INSERT INTO meta (key, value) VALUES ('after-backup', 'x')").run();
  } finally {
    handle.close();
  }

  const restored = run('restore-tables', '--part', 'memory', '--from', backup, '--db', file);
  assert.equal(restored.code, 0, restored.err.join('\n'));

  assert.deepEqual(memoryOf(read(file)), fromBackup);
  const after = openMemoryDb(file);
  try {
    assert.throws(() => dbOf(after).prepare("DELETE FROM work WHERE id = 't0000e001'").run());
  } finally {
    after.close();
  }
});
