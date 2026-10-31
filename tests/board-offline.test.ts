// The board read with the core down or running (tools/memory-db.mjs `board list` and `board show`): both open the
// database read-only, so they take no lock, migrate nothing and write nothing. Synthetic tasks, temporary files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { main, tableHashes } from '../tools/memory-db.mjs';
import { openBoard } from '../src/board/board.ts';
import type { BoardSettings, TaskRecord, TaskView } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

function run(...argv: Array<string>): { code: unknown; lines: Array<string> } {
  const lines: Array<string> = [];
  const code: unknown = main(argv, {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  });
  return { code, lines };
}

/** A memory file with two tasks, the first with a comment; the ids in filing order. */
function withTasks(): { file: string; ids: Array<string> } {
  const dir = tempDir('nep-board-offline-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({ boss: { kind: 'cli', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] } })
  );
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file);
  try {
    const board = openBoard({ db: dbOf(handle), privateDir: dir, now: () => NOW, settings: () => SETTINGS });
    const first = board.call('boss', 'task.add', { title: 'first task' });
    board.call('boss', 'task.comment', { id: first.id, text: 'Σχόλιο' });
    const second = board.call('boss', 'task.add', { title: 'second task' });
    return { file, ids: [first.id, second.id] };
  } finally {
    handle.close();
  }
}

const hashesOf = (file: string): unknown => {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return tableHashes(handle.db);
  } finally {
    handle.close();
  }
};

/** A writer lock held by a live process: this test's own pid. */
const holdLock = (file: string): void =>
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, startedAt: new Date(NOW).toISOString() }));

test('board list prints every task while the core holds the lock, and writes nothing', () => {
  const { file, ids } = withTasks();
  const before = hashesOf(file);
  holdLock(file);

  const listed = run('board', 'list', '--db', file, '--json');
  assert.equal(listed.code, 0, listed.lines.join('\n'));
  assert.equal(listed.lines.length, 1);
  // `--json` prints the answer of task.list (the brief of PR 6a), and the assertions below check its fields.
  const tasks = JSON.parse(listed.lines[0] ?? '') as Array<TaskRecord>;
  assert.deepEqual(
    tasks.map((task) => [task.id, task.status, task.title]),
    [
      [ids[0], 'proposed', 'first task'],
      [ids[1], 'proposed', 'second task'],
    ]
  );
  fs.rmSync(`${file}.lock`);
  assert.deepEqual(hashesOf(file), before);
});

test('board show prints one task with its comments and events while the core holds the lock', () => {
  const { file, ids } = withTasks();
  holdLock(file);

  const shown = run('board', 'show', ids[0] ?? '', '--db', file, '--json');
  assert.equal(shown.code, 0, shown.lines.join('\n'));
  // `--json` prints the answer of task.show (the brief of PR 6a), and the assertions below check its fields.
  const view = JSON.parse(shown.lines[0] ?? '') as TaskView;
  assert.equal(view.task.id, ids[0]);
  assert.deepEqual(
    view.comments.map((comment) => comment.text),
    ['Σχόλιο']
  );
  assert.ok(view.events.some((event) => event.type === 'task.created'));
});

test('board show of an id the board does not hold exits 1', () => {
  const { file } = withTasks();
  assert.equal(run('board', 'show', 'T-zzzzzz', '--db', file, '--json').code, 1);
});

test('board list of a memory file without its board exits 1 and creates no board', () => {
  const dir = tempDir('nep-board-offline-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 20), boardMigrations: [] }).close();
  const before = hashesOf(file);

  assert.equal(run('board', 'list', '--db', file, '--json').code, 1);
  assert.deepEqual(hashesOf(file), before);
});

test('board list of an empty board prints an empty list', () => {
  const dir = tempDir('nep-board-offline-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file).close();

  const listed = run('board', 'list', '--db', file, '--json');
  assert.equal(listed.code, 0, listed.lines.join('\n'));
  assert.deepEqual(JSON.parse(listed.lines[0] ?? ''), []);
});
