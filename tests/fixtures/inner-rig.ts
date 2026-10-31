// Pieces of the inner life's test rig (tests/inner.test.js): a seeded random stream for its draws, and the memory
// database of an inner life under test with the reads of its wake queue (src/memory/db/wake-queue.ts). The queue, the
// handled set and the in-flight mark live in the database, never in inner.json (stage 4 cut, the lead's decision 1), so
// a test that checks what is durable reads them here. The service runs on the calling thread over the test's data
// directory, so the open imports any inner.json the test wrote. Synthetic data only.
import type { Wake } from '../../src/behavior/inner/types.ts';
import { wakeOf } from '../../src/memory/db/wake-queue.ts';
import type { StoredWake } from '../../src/memory/db/wake-queue.ts';
import { openTestMemorySync } from './memory-db/service.js';

/** The node:sqlite shape of the service's read connection while the database is open. */
type Read = { db: { prepare(sql: string): { all(...params: Array<string>): Array<unknown> } } };

/** A seeded stream in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether `value` is a read connection: an object whose `db` can prepare a statement. */
function isRead(value: unknown): value is Read {
  const db: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'db') : null;
  return typeof db === 'object' && db !== null && typeof Reflect.get(db, 'prepare') === 'function';
}

/** What the rig's tests read of the wake queue. */
export type WakeMemory = {
  memoryDb: ReturnType<typeof openTestMemorySync>['memoryDb'];
  /** The stored wakes in `state`, the oldest queued first. */
  wakes(state: string): Array<StoredWake | null>;
  /** One stored wake, or null. */
  wake(id: string): StoredWake | null;
  /** The queued wakes as the queue holds them (a stored wake's payload is the wake). */
  queue(): Array<Wake>;
};

/** The memory database over `dataDir`, opened now with the clock `now`, and the reads of its wake queue. */
export function wakeMemory(dataDir: string, now: () => number): WakeMemory {
  const { memoryDb } = openTestMemorySync({ dataDir, now });
  const read = (): Read => {
    const handle: unknown = memoryDb.readHandle();
    if (!isRead(handle)) throw new Error('the memory database is not open');
    return handle;
  };
  const wakes = (state: string): Array<StoredWake | null> =>
    read()
      .db.prepare('SELECT id FROM wakes WHERE state = ? ORDER BY queued_at, id')
      .all(state)
      .map((row) => wakeOf(read(), String(Reflect.get(Object(row), 'id'))));
  return {
    memoryDb,
    wakes,
    wake: (id) => wakeOf(read(), id),
    // The payload is the wake object the queue stored whole (wake-queue.ts#queueWake).
    queue: () => wakes('queued').flatMap((stored) => (stored ? [stored.payload as Wake] : [])),
  };
}
