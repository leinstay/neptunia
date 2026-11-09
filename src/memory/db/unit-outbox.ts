// The writes of memory units waiting for the database (spec 2026-10-24-memory-authority, section 6 item 3): the
// store's cache (src/memory/store.ts) and the module stores (src/intentions/store.ts, src/errands/store.ts) hand the
// units they changed to an outbox, and the outbox sends them
// through the writer (`memoryDb.writeUnit`, unit-write.ts). A unit stays in the outbox until its write resolved, so the
// caller's in-process value is the truth meanwhile and a failed write is never lost:
//   - `value(owner, value)`   a whole JSON unit (op `value`): a newer value of the same unit replaces the one waiting
//                             (the latest is all the database needs);
//   - `lines(owner, lines)`   lines of a JSONL unit (op `lines`): appended to what waits for that unit, in
//                             order;
//   - `push()`                sends what waits, at most one write per unit under way (so the lines of one unit land
//                             in their order); a failed write goes back in front of what came meanwhile and is tried
//                             again at the next push; resolves once the writes it started settled;
//   - `flush({ rounds })`     pushes until nothing waits or a round wrote nothing more;
//   - `keep()`                at shutdown: every unit still waiting is handed to `memoryDb.keepPending` (the
//                             `memory-pending/` folder the service replays at its next start) and leaves the outbox;
//                             returns how many, an error logged with the count;
//   - `holds(owner)`          whether a write of the unit waits or is under way (its cache entry is not clean yet);
//   - `size()`                how many units wait or are under way.
// Logs carry codes and counts only.

import { intentionsOfUnit } from './intentions-write.ts';
import type { IntentionsWrite } from './intentions-write.ts';
import { operationalOfUnit } from './operational.ts';
import type { OperationalWrite } from './operational.ts';
import { keyText } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import type { Log, Row } from './types.ts';

const noop = (): void => {};

/** A unit waiting to be written: a whole value, or lines to append. */
type Waiting = { op: 'value'; value: unknown } | { op: 'lines'; lines: Array<unknown> };

/** What a unit outbox offers: queue a value or lines, push and flush them, keep them at shutdown. */
export type UnitOutbox = {
  value: (owner: StorageKey | string, next: unknown) => void;
  lines: (owner: StorageKey | string, list: unknown) => void;
  push: () => Promise<number>;
  flush: (options?: { rounds?: number }) => Promise<number>;
  keep: () => number;
  holds: (owner: StorageKey | string) => boolean;
  size: () => number;
};

/**
 * The memory service as the outbox uses it: `writeUnit` always, `writeOperational` for a unit of an operational kind
 * and `writeIntentions` for a unit of the intentions when the service has them (operational.ts, intentions-write.ts),
 * `keepPending` at shutdown.
 */
type OutboxMemoryDb = {
  writeUnit(update: Row): Promise<unknown>;
  writeOperational?(write: OperationalWrite): Promise<unknown>;
  writeIntentions?(write: IntentionsWrite): Promise<unknown>;
  keepPending?(update: Row): unknown;
};

/**
 * `name` says whose outbox it is in the logs (`store`, `intentions`, `tasks`).
 */
export function createUnitOutbox({
  memoryDb,
  log = { info: noop, warn: noop, error: noop, debug: noop },
  name,
}: {
  memoryDb: OutboxMemoryDb;
  log?: Pick<Log, 'warn'> & Partial<Log>;
  name: string;
}): UnitOutbox {
  // owner -> { op: 'value', value } | { op: 'lines', lines: [] }
  const waiting = new Map<string, Waiting>();
  // owner -> the promise of the write under way
  const sending = new Map<string, Promise<boolean>>();

  function value(ownerGiven: StorageKey | string, next: unknown): void {
    const owner = typeof ownerGiven === 'string' ? ownerGiven : keyText(ownerGiven);
    waiting.set(owner, { op: 'value', value: next });
  }

  function lines(key: StorageKey | string, list: unknown): void {
    const owner = typeof key === 'string' ? key : keyText(key);
    if (!Array.isArray(list) || list.length === 0) return;
    const held = waiting.get(owner);
    if (held?.op === 'lines') held.lines.push(...(list as Array<unknown>));
    else waiting.set(owner, { op: 'lines', lines: [...(list as Array<unknown>)] });
  }

  /** The update of a waiting unit, as the writer takes it. */
  const updateOf = (owner: string, item: Waiting): Row => {
    const target = owner.startsWith('{') ? { key: JSON.parse(owner) as StorageKey } : { owner };
    return item.op === 'value'
      ? { op: 'value', ...target, value: item.value }
      : { op: 'lines', ...target, lines: item.lines };
  };

  /** The write of a waiting unit: the direct write of its kind where the service has one, else the unit write. */
  function send(owner: string, item: Waiting): Promise<unknown> {
    const update = updateOf(owner, item);
    const operational = memoryDb.writeOperational ? operationalOfUnit(update) : null;
    if (operational && memoryDb.writeOperational) return memoryDb.writeOperational(operational);
    const intentions = memoryDb.writeIntentions ? intentionsOfUnit(update) : null;
    if (intentions && memoryDb.writeIntentions) return memoryDb.writeIntentions(intentions);
    return memoryDb.writeUnit(update);
  }

  /** A failed write back in the outbox: a newer value stays; lines go in front of the ones that came meanwhile. */
  function putBack(owner: string, item: Waiting): void {
    const now = waiting.get(owner);
    if (item.op === 'value') {
      if (!now) waiting.set(owner, item);
      return;
    }
    if (now?.op === 'lines') now.lines.unshift(...item.lines);
    else waiting.set(owner, item);
  }

  async function push(): Promise<number> {
    const started: Array<Promise<boolean>> = [];
    let failed = 0;
    let code: unknown = null;
    for (const [owner, item] of [...waiting]) {
      if (sending.has(owner)) continue;
      waiting.delete(owner);
      const done: Promise<boolean> = Promise.resolve()
        .then(() => send(owner, item))
        .then(
          () => true,
          (error: unknown) => {
            putBack(owner, item);
            failed += 1;
            code = (error as { code?: unknown } | null)?.code ?? null;
            return false;
          }
        )
        .finally(() => {
          if (sending.get(owner) === done) sending.delete(owner);
        });
      sending.set(owner, done);
      started.push(done);
    }
    const results = await Promise.all(started);
    if (failed > 0) log.warn('memory db: unit write failed', { reader: name, units: failed, code });
    return results.filter(Boolean).length;
  }

  /** Pushes until nothing waits, or a round brought no write through (then what is left waits for the next push). */
  async function flush({ rounds = 3 }: { rounds?: number } = {}): Promise<number> {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.allSettled([...sending.values()]);
      if (waiting.size === 0) break;
      if ((await push()) === 0) break;
    }
    await Promise.allSettled([...sending.values()]);
    return waiting.size;
  }

  function keep(): number {
    if (waiting.size === 0) return 0;
    let kept = 0;
    let code: unknown = null;
    for (const [owner, item] of [...waiting]) {
      try {
        if (typeof memoryDb?.keepPending !== 'function')
          throw Object.assign(new Error('memory db: no pending folder'), { code: 'NO_PENDING' });
        memoryDb.keepPending(updateOf(owner, item));
        waiting.delete(owner);
        kept += 1;
      } catch (error) {
        code = (error as { code?: unknown } | null)?.code ?? null;
      }
    }
    if (kept > 0) log.error?.('memory db: units kept pending', { reader: name, units: kept });
    if (waiting.size > 0) log.error?.('memory db: units lost', { reader: name, units: waiting.size, code });
    return kept;
  }

  return {
    value,
    lines,
    push,
    flush,
    keep,
    holds: (key: StorageKey | string) => {
      const owner = typeof key === 'string' ? key : keyText(key);
      return waiting.has(owner) || sending.has(owner);
    },
    size: () => new Set([...waiting.keys(), ...sending.keys()]).size,
  };
}
