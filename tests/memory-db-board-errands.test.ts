// scripts/memory-db.ts over a database that holds errands in the `work` archive: `restore-tables --part memory` brings
// the archive back from a backup and leaves its guards on. The archive comes from fixtures/errand-archive.ts.
// Temporary directories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { main, tableHashes } from '../scripts/memory-db.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { archiveDataDir } from './fixtures/errand-archive.ts';

type Hash = { table: string; rows: number; hash: string };

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

function run(...argv: Array<string>): { code: unknown; out: Array<string>; err: Array<string> } {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code: unknown = main(argv, { out: (line: string) => out.push(line), err: (line: string) => err.push(line) });
  return { code, out, err };
}

/** The archive opened once by the current code, then `change` on the open file. */
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

test('a memory-only restore brings the archive back from the backup', () => {
  const { dataDir, file } = moved();
  const backup = path.join(path.dirname(dataDir), 'backup');
  // The backup the way the server's backup timer takes one: `VACUUM INTO` over a read-only connection.
  fs.mkdirSync(backup);
  const source = new DatabaseSync(file, { readOnly: true });
  source.prepare('VACUUM INTO ?').run(path.join(backup, 'memory.db'));
  source.close();
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
});
