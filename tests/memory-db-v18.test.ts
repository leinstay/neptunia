// Schema v18 of the memory database (spec 2026-10-27-stage-4-cut, PR B): the wake queue moves from each guild's
// `inner.json` into the `wakes` table. The data step reads every `guilds/<id>/inner.json` under the opener's
// `context.dataDir` once, in one transaction, and keeps the wake ids: the queue becomes `queued`, the handled set
// `handled`, and the wake of the in-flight mark `running` with a lease that expired when that turn started, so the
// recovery of the next start resolves it. The file is then renamed to `inner.json.imported`, and a later open changes
// nothing. The rows are read back through src/memory/db/wake-queue.ts. Synthetic data, a temporary data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { recoverWakes, wakeOf } from '../src/memory/db/wake-queue.ts';
import { emptyState, reviewWake, wakeOfDue } from '../src/behavior/inner.ts';
import { openTestMemory } from './fixtures/memory-db/service.js';
import { tempDir } from './fixtures/tmp.js';

type Statement = { get(...params: Array<unknown>): Record<string, unknown> | undefined };
type Db = { prepare(sql: string): Statement };

const GUILD = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// The moments the state file holds: data, never a clock reading.
const STARTED = Date.parse('2026-10-31T09:58:00.000Z');
const DUE = STARTED - MINUTE;

const RUNNING = wakeOfDue({
  intention: { id: 'i1', provenance: { scope: 'group', channelId: 'c1' } },
  reason: 'due',
  at: DUE,
});
const QUEUED = reviewWake('2026-10-31', STARTED);
const HANDLED = `inner.wake:intention_due:i0:${STARTED - 2 * HOUR}`;

/** One guild's state as the engine wrote it: two queued wakes, the first in flight, and one handled wake. */
function innerState(): Record<string, unknown> {
  return {
    ...emptyState(),
    queue: [
      { ...RUNNING, queuedAt: DUE },
      { ...QUEUED, queuedAt: STARTED },
    ],
    handled: { [HANDLED]: { at: STARTED - HOUR, outcome: 'spoke' } },
    inflight: {
      turnId: 't-cut-off',
      wakeIds: [RUNNING.id],
      kind: 'intention_due',
      startedAt: STARTED,
      channelId: 'c1',
      privateChat: false,
      privateUserId: null,
    },
  };
}

/** A data directory with a v17 memory database and the guild's `inner.json` beside it. */
function upgradeable(): { dataDir: string; file: string; inner: string } {
  const dataDir = tempDir('nep-v18-');
  const file = path.join(dataDir, 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 17) }).close();
  const inner = path.join(dataDir, 'guilds', GUILD, 'inner.json');
  fs.mkdirSync(path.dirname(inner), { recursive: true });
  fs.writeFileSync(inner, JSON.stringify(innerState()));
  return { dataDir, file, inner };
}

/** The number of wake rows (open.js is untyped JS: its connection is read through this shape). */
function wakeCount(handle: { db: unknown }): unknown {
  const db = handle.db as Db;
  return db.prepare('SELECT COUNT(*) AS n FROM wakes').get()?.n;
}

/** The service's read connection, which its JS source leaves untyped; refused when the database is not open. */
function readHandleOf(memoryDb: { readHandle(): unknown }): { db: object } {
  const handle = memoryDb.readHandle();
  const db: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'db') : null;
  if (typeof db !== 'object' || db === null) throw new Error('the memory database is not open');
  return { db };
}

test('the v18 step imports the queue, the handled set and the in-flight mark with their ids, and sets the file aside', () => {
  const { dataDir, file, inner } = upgradeable();
  const handle = openMemoryDb(file, { context: { dataDir } });
  try {
    const running = wakeOf(handle, RUNNING.id);
    assert.equal(running?.state, 'running');
    assert.equal(running?.kind, 'intention_due');
    assert.equal(running?.dueAt, DUE);
    assert.equal(running?.leaseExpiresAt, STARTED, 'the lease expired when the cut-off turn started');
    assert.deepEqual(running?.payload.intentionIds, ['i1']);
    const queued = wakeOf(handle, QUEUED.id);
    assert.equal(queued?.state, 'queued');
    assert.equal(queued?.kind, 'review');
    assert.equal(queued?.queuedAt, STARTED);
    const handled = wakeOf(handle, HANDLED);
    assert.equal(handled?.state, 'handled');
    assert.equal(handled?.kind, 'intention_due', 'the kind of a handled id is the one its id names');
    assert.equal(handled?.handledAt, STARTED - HOUR);
    assert.equal(handled?.outcome, 'spoke');
    assert.equal(wakeCount(handle), 3);
  } finally {
    handle.close();
  }
  assert.equal(fs.existsSync(inner), false);
  assert.equal(fs.existsSync(`${inner}.imported`), true);
});

test('a second open of the imported database changes no wake and imports nothing again', () => {
  const { dataDir, file, inner } = upgradeable();
  const read = () => {
    const handle = openMemoryDb(file, { context: { dataDir } });
    try {
      return { count: wakeCount(handle), rows: [RUNNING.id, QUEUED.id, HANDLED].map((id) => wakeOf(handle, id)) };
    } finally {
      handle.close();
    }
  };
  const first = read();
  const second = read();
  assert.deepEqual(second, first);
  assert.equal(fs.existsSync(inner), false);
  assert.equal(
    fs.readFileSync(`${inner}.imported`, 'utf8'),
    JSON.stringify(innerState()),
    'the old file is kept as it was'
  );
});

test('the imported in-flight wake is queued again by the recovery of the next start', () => {
  const { dataDir, file } = upgradeable();
  const handle = openMemoryDb(file, { context: { dataDir } });
  try {
    assert.deepEqual(recoverWakes(handle, { now: STARTED + 10 * MINUTE }), { handled: 0, requeued: 1 });
    assert.equal(wakeOf(handle, RUNNING.id)?.state, 'queued');
  } finally {
    handle.close();
  }
});

test('the memory service hands its data directory to the v18 step, so its open imports the guild file', async () => {
  const { dataDir, inner } = upgradeable();
  const memory = await openTestMemory({ dataDir });
  try {
    assert.equal(wakeOf(readHandleOf(memory.memoryDb), QUEUED.id)?.state, 'queued');
  } finally {
    await memory.close();
  }
  assert.equal(fs.existsSync(`${inner}.imported`), true);
});
