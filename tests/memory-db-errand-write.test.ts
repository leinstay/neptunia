// The errand store's write as its own kind of the writer (src/memory/db/errand-write.ts, write kind `errand`): the
// board brought to the errand, and the closing journal line of an end in the same transaction, named by its place and
// with no unit. Synthetic errands over a fresh memory database and a test memory service.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyErrandWrite } from '../src/memory/db/errand-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { createErrandStore } from '../src/errands/store.ts';
import { createJournal } from '../src/memory/journal.ts';
import { reproject } from '../src/memory/db/graph.ts';
import { UNIT_OF } from '../src/memory/db/graph-manifest.ts';
import { tableHashes } from '../scripts/memory-db.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { openTestMemorySync, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-10T10:00:00Z');
const PERSONA = 'persona:local';

const errand = (state: string, more: Row = {}): Row => ({
  id: 'errand-1',
  agent: 'scout',
  goal: 'find the opening hours',
  state,
  createdAt: NOW,
  requester: { kind: 'member', accountId: 'u1' },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group',
  ...more,
});

const statusOf = (db: Db, id: string): unknown =>
  db.prepare('SELECT status FROM board_tasks WHERE id = ?').get(id)?.status;
const journalDays = (db: Db): number =>
  Number(db.prepare("SELECT count(*) AS n FROM day WHERE writer = 'journal' AND holder_id = ?").get(PERSONA)?.n);

const closingLine = (): Row => ({
  placeId: PERSONA,
  line: {
    v: 1,
    kind: 'action',
    id: 'line-1',
    occurredAt: '2026-11-10T10:00:01.000Z',
    name: 'errand',
    phase: 'succeeded',
    opId: 'op-1',
    errandId: 'errand-1',
  },
});

test('an errand write files the task, and its end moves it and writes the closing line by its place', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW,
      errand: errand('queued'),
      delivered: false,
      closing: null,
      now: NOW,
    });
    assert.equal(statusOf(db, 'errand-1'), 'approved');
    assert.equal(journalDays(db), 0);
    const answer = applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW + 1000,
      errand: errand('done', { startedAt: NOW + 10, endedAt: NOW + 1000, result: { text: 'eight' } }),
      delivered: false,
      closing: closingLine(),
      now: NOW + 1000,
      iface: 'discord',
    });
    assert.deepEqual(answer, { ended: true });
    assert.equal(statusOf(db, 'errand-1'), 'done');
    assert.equal(journalDays(db), 1);
  } finally {
    handle.close();
  }
});

const boardRows = (db: Db, id: string): { task: Row; events: Array<Row>; outbox: Array<Row> } => ({
  task: { ...db.prepare('SELECT status, close_reason, updated_at FROM board_tasks WHERE id = ?').get(id) },
  events: db
    .prepare('SELECT actor, type, old, new, created_at FROM board_events WHERE task_id = ? ORDER BY seq')
    .all(id)
    .map((row) => ({ ...row })),
  outbox: db
    .prepare('SELECT to_whom, kind, created_at, delivered_at FROM board_outbox WHERE task_id = ? ORDER BY seq')
    .all(id)
    .map((row) => ({ ...row })),
});

test('an errand that started and failed in one write leaves a status event per step and one outbox row to persona', () => {
  // Bug: the errand's own update, written without the board's move, skips in_progress in the history, loses the
  // error, stamps the rows with the wrong time or writes the end's outbox row to nobody, so pendingEnds never sees it.
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW,
      errand: errand('queued'),
      delivered: false,
      closing: null,
      now: NOW,
    });
    const at = NOW + 1000;
    applyErrandWrite(handle, {
      id: 'errand-1',
      at,
      errand: errand('failed', { startedAt: NOW + 10, endedAt: at, error: 'the site was down' }),
      delivered: false,
      closing: null,
      now: at,
    });
    const first = new Date(NOW).toISOString();
    const end = new Date(at).toISOString();
    assert.deepEqual(boardRows(db, 'errand-1'), {
      task: { status: 'failed', close_reason: 'the site was down', updated_at: end },
      events: [
        { actor: 'core', type: 'status', old: null, new: 'approved', created_at: first },
        { actor: 'core', type: 'status', old: 'approved', new: 'in_progress', created_at: end },
        { actor: 'core', type: 'status', old: 'in_progress', new: 'failed', created_at: end },
      ],
      outbox: [{ to_whom: 'persona', kind: 'failed', created_at: end, delivered_at: null }],
    });
  } finally {
    handle.close();
  }
});

test('an end written a second time adds no status event and no outbox row', () => {
  // Bug: a save that moves a closed task again, so a replayed end writes a second outbox row and opens a second result
  // turn.
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    const done = errand('done', { startedAt: NOW + 10, endedAt: NOW + 1000, result: { text: 'eight' } });
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW,
      errand: errand('queued'),
      delivered: false,
      closing: null,
      now: NOW,
    });
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW + 1000,
      errand: done,
      delivered: false,
      closing: null,
      now: NOW + 1000,
    });
    const before = boardRows(db, 'errand-1');
    const answer = applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW + 2000,
      errand: done,
      delivered: false,
      closing: closingLine(),
      now: NOW + 2000,
    });
    assert.deepEqual(answer, { ended: false });
    assert.deepEqual(boardRows(db, 'errand-1'), before);
    assert.equal(journalDays(db), 0);
  } finally {
    handle.close();
  }
});

// Moved from tests/board.test.ts, which goes with the board's own operations: the errand write is the board's only
// writer left.
test('an errand write projects nothing into her memory graph and no board table is a unit', () => {
  // Bug: a board row that reaches her graph or an export's files, so an errand's history shows up in recall.
  const handle = freshMemoryDb();
  try {
    const watched = ['graph_nodes', 'graph_edges', 'node_access', 'files'];
    const before = tableHashes(handle.db, watched);
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW,
      errand: errand('queued'),
      delivered: false,
      closing: null,
      now: NOW,
    });
    applyErrandWrite(handle, {
      id: 'errand-1',
      at: NOW + 1000,
      errand: errand('done', { startedAt: NOW + 10, endedAt: NOW + 1000, result: { text: 'eight' } }),
      delivered: false,
      closing: null,
      now: NOW + 1000,
    });
    reproject(handle, { at: new Date(NOW + 2000).toISOString() });
    assert.deepEqual(tableHashes(handle.db, watched), before);
    assert.deepEqual(
      Object.keys(UNIT_OF).filter((table) => table.startsWith('board_')),
      []
    );
  } finally {
    handle.close();
  }
});

test('an errand write with no errand id is refused and writes nothing', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    assert.throws(
      () => applyErrandWrite(handle, { at: NOW, errand: errand('queued'), closing: closingLine(), now: NOW }),
      (error: unknown) => (error as { code?: unknown }).code === 'ERRAND_WRITE_ID'
    );
    assert.equal(statusOf(db, 'errand-1'), undefined);
    assert.equal(journalDays(db), 0);
  } finally {
    handle.close();
  }
});

const OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of OPENED) await memory.close();
});

test('the errand store writes through the errand kind of the service', async () => {
  const memory = openTestMemorySync({ dataDir: tempDataDir('nep-errand-kind-'), now: () => NOW });
  OPENED.push(memory);
  // The service has no unit write.
  const { memoryDb } = memory;
  const journal = createJournal({ dataDir: memory.dataDir, now: () => NOW, memoryDb });
  const store = createErrandStore({
    memoryDb,
    journal,
    now: () => NOW,
    config: () => ({ errands: { maxOpen: 3 }, agents: { scout: { daily: { tasks: 5 } } } }),
  });
  const added = store.add({
    agent: 'scout',
    goal: 'find the opening hours',
    requester: { kind: 'member', accountId: 'u1' },
    origin: { placeId: 'c1', messageId: 'm1' },
    scope: 'group',
  });
  const id = added.ok ? String(added.errand.id) : '';
  store.start(id);
  store.finish(id, { status: 'done', result: { text: 'eight', sources: [], files: [] }, usage: { usd: 0 } });
  assert.equal((await store.flush()).waiting, 0);
  const db = dbOf(memory.memoryDb.readHandle() as never);
  assert.equal(statusOf(db, id), 'done');
  const lines = db.prepare("SELECT count(*) AS n FROM day WHERE writer = 'journal' AND work_id = ?").get(id)?.n;
  // Queued, started, and the closing line written with the end.
  assert.equal(Number(lines), 3);
});
