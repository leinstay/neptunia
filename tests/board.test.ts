// The board's operations (src/board/board.ts) where they meet the rest of the core: the rights a principal holds come
// from its `boardRoles` in the private layer's clients.json, read at every call; a board that is not at its version
// answers `board-unavailable`; and a board write reaches neither her memory graph nor the files an export reads.
// Temporary directories only, a fixed clock, synthetic principals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { reproject } from '../src/memory/db/graph.js';
import { UNIT_OF } from '../src/memory/db/graph-manifest.js';
import { tableHashes } from '../tools/memory-db.mjs';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardOp, BoardSettings, TaskRecord } from '../src/board/board.ts';
import { BoardError } from '../src/board/machine.ts';
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

/** Writes clients.json: each name with its `boardRoles`, or with no such field when the value is null. */
function writeClients(dir: string, roles: Record<string, ReadonlyArray<string> | null>): void {
  const entries = Object.fromEntries(
    Object.entries(roles).map(([name, list]) => [
      name,
      {
        kind: 'cli',
        tokenFile: `clients/${name}.token`,
        permissions: [],
        ...(list === null ? {} : { boardRoles: list }),
      },
    ])
  );
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(entries));
}

const CLIENTS = {
  boss: ['owner'],
  rev: ['reviewer'],
  hand: ['worker'],
  eyes: ['watcher'],
  her: ['persona'],
  bare: null,
  typo: ['admin', 'Owner'],
  derived: ['holder', 'requester', 'answerer', 'reaper'],
};

function setUp(boardMigrations?: ReadonlyArray<string>): { board: Board; dir: string; db: BoardDb; close: () => void } {
  const dir = tempDir('nep-board-');
  writeClients(dir, CLIENTS);
  const handle = boardMigrations ? openMemoryDb(':memory:', { boardMigrations }) : openMemoryDb(':memory:');
  const db = dbOf(handle);
  const board = openBoard({ db, privateDir: dir, now: () => NOW, settings: () => SETTINGS });
  return { board, dir, db, close: () => handle.close() };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (error) {
    if (error instanceof BoardError) return error.code;
    throw error;
  }
}

/** A dev task the owner filed, triaged and approved, claimed by the worker `hand`. */
function heldTask(board: Board): TaskRecord {
  const added = board.call('boss', 'task.add', { title: 'held task', lane: 'dev', project: 'core' });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' });
  return board.call('hand', 'task.claim', { id: added.id });
}

test('a principal whose entry grants no board role is refused every operation with forbidden and changes nothing', () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    const before = board.call('boss', 'task.show', { id: task.id });
    const calls: Array<[BoardOp, Record<string, unknown>]> = [
      ['task.add', {}],
      ['task.list', {}],
      ['task.show', { id: task.id }],
      ['task.update', { id: task.id, revision: task.revision, title: 'renamed' }],
      ['task.transition', { id: task.id, status: 'cancelled', revision: task.revision, close_reason: 'x' }],
      ['task.claim', { id: task.id }],
      ['task.heartbeat', { id: task.id }],
      ['task.release', { id: task.id }],
      ['task.retry', { id: task.id }],
      ['task.depend', { id: task.id, on: task.id }],
      ['task.undepend', { id: task.id, on: task.id }],
      ['task.ask', { id: task.id, text: 'which?', to_whom: 'owner' }],
      ['task.answer', { question_id: 'Q-aaaaaa', text: 'this' }],
      ['task.escalate', { question_id: 'Q-aaaaaa' }],
      ['task.approve', { id: task.id, scope: 'deploy' }],
      ['task.result', { id: task.id, kind: 'summary', body: 'done' }],
      ['task.comment', { id: task.id, text: 'a note' }],
      ['attempt.start', { task_id: task.id }],
      ['attempt.end', { attempt_id: 'A-aaaaaa', outcome: 'done' }],
      ['run.start', { wave: 1 }],
      ['run.end', { id: 'U-aaaaaa' }],
      ['costs.agents', {}],
      ['outbox.pull', { ack: 1000 }],
    ];
    for (const [op, args] of calls)
      assert.equal(
        codeOf(() => board.call('bare', op, args)),
        'forbidden',
        op
      );
    const after = board.call('boss', 'task.show', { id: task.id });
    assert.equal(after.task.revision, before.task.revision);
    assert.equal(after.task.lease_owner, 'hand');
    assert.equal(after.events.length, before.events.length);
    assert.equal(board.call('boss', 'task.list', {}).length, 1);
  } finally {
    close();
  }
});

test('a principal absent from clients.json is refused, and nothing is filed', () => {
  const { board, close } = setUp();
  try {
    assert.equal(
      codeOf(() => board.call('stranger', 'task.add', { title: 'sneaked in' })),
      'forbidden'
    );
    assert.deepEqual(board.call('boss', 'task.list', {}), []);
  } finally {
    close();
  }
});

test('a role name outside the board roles grants nothing, whatever its spelling', () => {
  const { board, close } = setUp();
  try {
    assert.equal(
      codeOf(() => board.call('typo', 'task.add', { title: 'x' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('typo', 'task.list', {})),
      'forbidden'
    );
  } finally {
    close();
  }
});

test("a derived role listed in clients.json does not make a principal the holder of another's task", () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    assert.equal(
      codeOf(() => board.call('derived', 'task.heartbeat', { id: task.id })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('derived', 'task.release', { id: task.id })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.show', { id: task.id }).task.lease_owner, 'hand');
  } finally {
    close();
  }
});

test('a watcher reads the board and is refused a comment', () => {
  const { board, close } = setUp();
  try {
    const task = board.call('boss', 'task.add', { title: 'watched' });
    assert.deepEqual(
      board.call('eyes', 'task.list', {}).map((row) => row.id),
      [task.id]
    );
    assert.equal(board.call('eyes', 'task.show', { id: task.id }).task.title, 'watched');
    assert.equal(
      codeOf(() => board.call('eyes', 'task.comment', { id: task.id, text: 'seen' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('eyes', 'task.add', { title: 'mine' })),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('a role taken out of clients.json is gone at the next call', () => {
  const { board, dir, close } = setUp();
  try {
    const task = board.call('boss', 'task.add', { title: 'review me' });
    assert.equal(board.call('rev', 'task.comment', { id: task.id, text: 'first' }).comment.author, 'rev');
    writeClients(dir, { ...CLIENTS, rev: [] });
    assert.equal(
      codeOf(() => board.call('rev', 'task.comment', { id: task.id, text: 'second' })),
      'forbidden'
    );
    assert.deepEqual(
      board.call('boss', 'task.show', { id: task.id }).comments.map((row) => row.text),
      ['first']
    );
  } finally {
    close();
  }
});

test('a clients.json that is not JSON lets no principal act, the owner included', () => {
  const { board, dir, close } = setUp();
  try {
    fs.writeFileSync(path.join(dir, 'clients.json'), '{ "boss": ');
    assert.equal(
      codeOf(() => board.call('boss', 'task.add', { title: 'x' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('boss', 'task.list', {})),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('the owner role from clients.json approves a normal-risk plan, which the reviewer may not', () => {
  const { board, close } = setUp();
  try {
    const added = board.call('rev', 'task.add', { title: 'a plan', risk: 'normal' });
    const triaged = board.call('rev', 'task.transition', {
      id: added.id,
      status: 'triaged',
      revision: added.revision,
      set: { role: 'dev', estimate: 20, budget: 2 },
    });
    assert.equal(
      codeOf(() => board.call('rev', 'task.approve', { id: triaged.id, scope: 'plan' })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' }).task.status, 'approved');
  } finally {
    close();
  }
});

test('a persona principal files for a persona id and cancels that task as its requester; a worker may not file for her', () => {
  const { board, close } = setUp();
  try {
    const filed = board.call('her', 'task.add', { title: 'a wish', lane: 'dev', requester: 'persona:7' });
    assert.equal(filed.requester, 'persona:7');
    const cancelled = board.call('her', 'task.transition', {
      id: filed.id,
      status: 'cancelled',
      revision: filed.revision,
      close_reason: 'she changed her mind',
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      codeOf(() => board.call('hand', 'task.add', { title: 'forged', requester: 'persona:7' })),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('a deploy approval is recorded by the owner and refused to the reviewer', () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    assert.equal(
      codeOf(() => board.call('rev', 'task.approve', { id: task.id, scope: 'deploy' })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.approve', { id: task.id, scope: 'deploy' }).approval.scope, 'deploy');
    assert.deepEqual(
      board.call('boss', 'task.show', { id: task.id }).approvals.map((row) => row.principal),
      ['boss', 'boss']
    );
  } finally {
    close();
  }
});

test("a memory without its board answers board-unavailable to every operation, the owner's included", () => {
  const { board, close } = setUp([]);
  try {
    const ops: Array<[BoardOp, Record<string, unknown>]> = [
      ['task.list', {}],
      ['task.show', { id: 'T-aaaaaa' }],
      ['task.add', { title: 'x' }],
      ['task.comment', { id: 'T-aaaaaa', text: 'x' }],
      ['outbox.pull', {}],
    ];
    for (const [op, args] of ops)
      assert.equal(
        codeOf(() => board.call('boss', op, args)),
        'board-unavailable',
        op
      );
    assert.equal(
      codeOf(() => board.reap()),
      'board-unavailable'
    );
  } finally {
    close();
  }
});

test('a board write projects nothing into her memory graph and records no unit file', () => {
  const dir = tempDir('nep-board-');
  writeClients(dir, CLIENTS);
  const handle = openMemoryDb(':memory:');
  try {
    const board = openBoard({ db: dbOf(handle), privateDir: dir, now: () => NOW, settings: () => SETTINGS });
    const watched = ['graph_nodes', 'graph_edges', 'node_access', 'files'];
    const before = tableHashes(handle.db, watched);
    const task = heldTask(board);
    board.call('boss', 'task.comment', { id: task.id, text: 'a comment on the board' });
    board.call('hand', 'task.result', { id: task.id, kind: 'summary', body: 'the summary' });
    reproject(handle, { at: new Date(NOW).toISOString() });
    assert.deepEqual(tableHashes(handle.db, watched), before);
    assert.deepEqual(
      Object.keys(UNIT_OF).filter((table) => table.startsWith('board_')),
      []
    );
  } finally {
    handle.close();
  }
});
