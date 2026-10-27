// Schema v14, the JavaScript part: the intention records the list keeps name the errand they wait on or waited on
// under new fields. `awaitingTaskId`, `lastTaskId` and `outcome.taskId` become `awaitingErrandId`, `lastErrandId` and
// `outcome.errandId`, each in the place its key had, and an open record's note `task-missing` or `task-<state>` becomes
// `errand-missing` or `errand-<state>`. A closed record keeps its note, because the heartbeat prints it as the reason
// the intention ended. The `history` entries and the archived lines are history and stay as they were written. The
// records go in through the open of a v13 database and are read back from the `intentions` table. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './fixtures/tmp.js';
import {
  dumpTables,
  openCurrent,
  openV13,
  putIntentionUnits,
  type Db,
  type Record13,
} from './fixtures/memory-db/v13-errands.ts';

const T = 1_792_000_000_000;

/** An open record waiting on errand t0000000a. */
const WAITING: Record13 = {
  id: 'i-wait',
  purpose: 'ask about the trip',
  status: 'waiting',
  createdAt: T,
  updatedAt: T + 1,
  dueAt: null,
  awaitingTaskId: 't0000000a',
  waitDeadline: T + 5000,
  lastTaskId: null,
  history: [{ at: T, to: 'waiting', by: 'persona', code: 'wait' }],
};
/** An open record the errand's end moved to pending. */
const ENDED: Record13 = {
  id: 'i-ended',
  purpose: 'tell what the pier looks like',
  status: 'pending',
  createdAt: T,
  updatedAt: T + 2,
  awaitingTaskId: null,
  lastTaskId: 't0000000b',
  outcome: { taskId: 't0000000b', state: 'failed', error: 'timeout', at: T + 2 },
  note: 'task-failed',
  history: [{ at: T + 2, from: 'waiting', to: 'pending', by: 'engine', code: 'task-failed' }],
};
/** An open record whose errand the store no longer has. */
const MISSING: Record13 = {
  id: 'i-missing',
  purpose: 'check the harbour',
  status: 'pending',
  createdAt: T,
  updatedAt: T + 3,
  awaitingTaskId: null,
  lastTaskId: 't0000000c',
  note: 'task-missing',
  history: [{ at: T + 3, from: 'waiting', to: 'pending', by: 'engine', code: 'task-missing' }],
};
/** A closed record that still carries the note of its errand's end. */
const CLOSED: Record13 = {
  id: 'i-closed',
  purpose: 'report back',
  status: 'done',
  createdAt: T,
  updatedAt: T + 4,
  awaitingTaskId: null,
  lastTaskId: 't0000000d',
  outcome: { taskId: 't0000000d', state: 'done', at: T + 4 },
  note: 'task-done',
  history: [{ at: T + 4, from: 'pending', to: 'done', by: 'persona' }],
};
/** An archived line: history, never rewritten. */
const ARCHIVED: Record13 = {
  id: 'i-old',
  purpose: 'an old one',
  status: 'expired',
  createdAt: T - 9000,
  updatedAt: T - 8000,
  awaitingTaskId: null,
  lastTaskId: 't0000000e',
  outcome: { taskId: 't0000000e', state: 'done', at: T - 8000 },
  note: 'task-done',
  history: [{ at: T - 8000, to: 'expired', by: 'engine', code: 'task-done' }],
};

/** The same records as the code after the rename keeps them. */
const EXPECTED_WAITING: Record13 = {
  id: 'i-wait',
  purpose: 'ask about the trip',
  status: 'waiting',
  createdAt: T,
  updatedAt: T + 1,
  dueAt: null,
  awaitingErrandId: 't0000000a',
  waitDeadline: T + 5000,
  lastErrandId: null,
  history: [{ at: T, to: 'waiting', by: 'persona', code: 'wait' }],
};
const EXPECTED_ENDED: Record13 = {
  id: 'i-ended',
  purpose: 'tell what the pier looks like',
  status: 'pending',
  createdAt: T,
  updatedAt: T + 2,
  awaitingErrandId: null,
  lastErrandId: 't0000000b',
  outcome: { errandId: 't0000000b', state: 'failed', error: 'timeout', at: T + 2 },
  note: 'errand-failed',
  history: [{ at: T + 2, from: 'waiting', to: 'pending', by: 'engine', code: 'task-failed' }],
};
const EXPECTED_MISSING: Record13 = {
  id: 'i-missing',
  purpose: 'check the harbour',
  status: 'pending',
  createdAt: T,
  updatedAt: T + 3,
  awaitingErrandId: null,
  lastErrandId: 't0000000c',
  note: 'errand-missing',
  history: [{ at: T + 3, from: 'waiting', to: 'pending', by: 'engine', code: 'task-missing' }],
};
const EXPECTED_CLOSED: Record13 = {
  id: 'i-closed',
  purpose: 'report back',
  status: 'done',
  createdAt: T,
  updatedAt: T + 4,
  awaitingErrandId: null,
  lastErrandId: 't0000000d',
  outcome: { errandId: 't0000000d', state: 'done', at: T + 4 },
  note: 'task-done',
  history: [{ at: T + 4, from: 'pending', to: 'done', by: 'persona' }],
};

const fileOf = () => path.join(tempDir('nep-intent-move-'), 'memory.db');

function seeded(): string {
  const file = fileOf();
  const old = openV13(file);
  putIntentionUnits(old.db, 'g1', [WAITING, ENDED, MISSING, CLOSED], [ARCHIVED]);
  old.close();
  return file;
}

/** The `record` text of every intention row, by id. */
const recordsOf = (db: Db): Record<string, string> =>
  Object.fromEntries(
    db
      .prepare('SELECT id, record FROM intentions')
      .all()
      .map((row) => [String(row.id), String(row.record)])
  );

test('renames the three fields in place, so the key order of every record is the one it had', () => {
  const now = openCurrent(seeded());
  try {
    const records = recordsOf(now.db);
    assert.equal(records['i-wait'], JSON.stringify(EXPECTED_WAITING));
    assert.equal(records['i-ended'], JSON.stringify(EXPECTED_ENDED));
  } finally {
    now.close();
  }
});

test('renames the note of an open record, `task-missing` included', () => {
  const now = openCurrent(seeded());
  try {
    assert.equal(recordsOf(now.db)['i-missing'], JSON.stringify(EXPECTED_MISSING));
  } finally {
    now.close();
  }
});

test('keeps the note of a closed record while its fields are renamed', () => {
  const now = openCurrent(seeded());
  try {
    assert.equal(recordsOf(now.db)['i-closed'], JSON.stringify(EXPECTED_CLOSED));
  } finally {
    now.close();
  }
});

test('keeps the history entries of every record and every archived line as they were written', () => {
  const now = openCurrent(seeded());
  try {
    const records = recordsOf(now.db);
    const ended = JSON.parse(records['i-ended'] ?? 'null') as Record13;
    assert.equal((ended.outcome as Record<string, unknown>).errandId, 't0000000b', 'the record itself was moved');
    assert.deepEqual(ended.history, ENDED.history, 'the history entry still says task-failed');
    assert.equal(records['i-old'], JSON.stringify(ARCHIVED), 'the archived line is byte for byte the old one');
  } finally {
    now.close();
  }
});

test('finds nothing to change when the database is opened a second time', () => {
  const file = seeded();
  const first = openCurrent(file);
  const settled = dumpTables(first.db);
  first.close();
  const second = openCurrent(file);
  try {
    assert.deepEqual(dumpTables(second.db), settled);
    assert.equal(recordsOf(second.db)['i-wait'], JSON.stringify(EXPECTED_WAITING), 'settled, not left as it was');
  } finally {
    second.close();
  }
});

test('opens a database with no intention at all', () => {
  const file = fileOf();
  openV13(file).close();
  const now = openCurrent(file);
  try {
    assert.deepEqual(recordsOf(now.db), {});
  } finally {
    now.close();
  }
});
