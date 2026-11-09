// The store's cache of memory units and its one way to the writer (src/memory/store.ts builds one per store). A cached
// value is one unit of the memory database, named by `address(key)`; the store reads and changes the values, marks them
// dirty, and the cache hands a dirty unit's whole value to the outbox (src/memory/db/unit-outbox.ts) at a flush. The
// entry stays the truth until the outbox no longer holds it, and a failed write waits there for the next push.
//
// The database has another writer of the same units: her memory session moves a person's attitude. The service tells
// it (`memoryDb.onAffinityMoves`), and the cache, which subscribes at creation, drops every cached user unit of the moved
// person; one that is dirty or still in the outbox is marked `stale` instead and read again once its write has landed
// (its write keeps the session's score and reason, src/memory/db/session-rows.ts#sessionHold).
//
// A name `address` never registered is an operational file: read and written through `files`.

import { storageContext } from './db/map/index.ts';
import { unitValue } from './db/readers/common.ts';
import { keyText, storageId } from './db/storage-keys.ts';
import type { StorageKey, StorageKind } from './db/storage-keys.ts';
import { listUnits } from './db/storage-units.ts';
import type { UnitQuery } from './db/storage-units.ts';
import { createUnitOutbox } from './db/unit-outbox.ts';
import type { Db } from './db/types.ts';
import { canWriteUnits } from './types.ts';
import type { MemoryDb, Untyped } from './types.ts';
import { log } from '../log.ts';

/** A cached unit or file: its parsed value, whether it waits for a flush, the holds on that flush, and a pending re-read. */
export type CacheItem = { value: Untyped; dirty: boolean; holdFlush?: number; stale?: boolean };

/** What a flush did with one entry. */
export type FlushOutcome = 'clean' | 'held' | 'written' | 'failed';

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

/** How the cache reads and writes an operational file (the store's `readJson` and `writeJsonAtomic`). */
type Files = {
  read: (file: string, fallback: unknown) => unknown;
  write: (file: string, value: unknown) => void;
};

/** What a store asks of its cache (see the head of this file). */
export type UnitCache = {
  address: (key: StorageKey) => string;
  collection: (kind: StorageKind) => string;
  entry: (file: string, fallback: () => unknown) => CacheItem;
  cached: (file: string) => CacheItem | undefined;
  known: (file: string, onDisk: (file: string) => boolean) => boolean;
  idsUnder: (dir: string) => Array<string>;
  flushEntry: (file: string, item: CacheItem, options?: { force?: boolean }) => FlushOutcome;
  flushAll: (options?: { force?: boolean }) => { written: number; failed: number; held: number };
  writeNow: (file: string, item: CacheItem) => void;
  held: () => number;
  settle: () => Promise<number | undefined>;
  keep: () => number | undefined;
  drop: (keep: string) => number;
  reload: (file: string, item: CacheItem) => void;
  writable: () => boolean;
  lines: (key: StorageKey, list: Array<unknown>) => boolean;
  push: () => void;
  holds: (owner: StorageKey | string) => boolean;
  attitudeMoved: (moves: Array<{ personId: string; applied?: number }>) => number;
};

/**
 * The cache over `memoryDb`, reading through `seam`, with operational files through `files`.
 * See the head of this file.
 */
// health: allow function-length until 2027-04-01 -- one closure over the cache map and the outbox
export function createUnitCache({
  memoryDb,
  seam,
  files,
}: {
  memoryDb: MemoryDb;
  seam: Seam;
  files: Files;
}): UnitCache {
  const entries = new Map<string, CacheItem>();
  // The units a flush hands over, until their write resolved.
  const outbox = canWriteUnits(memoryDb) ? createUnitOutbox({ memoryDb, log, name: 'store' }) : null;
  const unitKeys = new Map<string, StorageKey>();
  const directoryQueries = new Map<string, UnitQuery>();

  /** The cache name of a unit, registered so a flush sends it to the database. */
  function address(key: StorageKey): string {
    const name = keyText(key);
    unitKeys.set(name, key);
    return name;
  }

  /** The cache name of a directory of units (`idsUnder`). */
  function collection(kind: StorageKind): string {
    const name = JSON.stringify({ kind });
    directoryQueries.set(name, { kind });
    return name;
  }

  /** The outbox's name of a cached entry: its storage key, or the file. */
  const ownerOf = (file: string): StorageKey | string => unitKeys.get(file) ?? file;
  const holds = (file: string): boolean => outbox?.holds(ownerOf(file)) ?? false;

  /** A cached entry, or the database's value (a file's), or `fallback()` for a unit nobody stored. */
  function entry(file: string, fallback: () => unknown): CacheItem {
    let item = entries.get(file);
    // A profile an attitude move made stale (`attitudeMoved`) is read again once its own write has landed.
    if (item?.stale && !item.dirty && !holds(file)) {
      entries.delete(file);
      item = undefined;
    }
    if (!item) {
      const key = unitKeys.get(file);
      let value: unknown;
      if (key) {
        // A memory unit: the database's value; a unit it does not hold is new.
        const unit = seam.run(() => unitValue(seam.db(), key));
        value = unit.found ? unit.value : fallback();
      } else {
        value = files.read(file, fallback());
      }
      item = { value, dirty: false };
      entries.set(file, item);
    }
    return item;
  }

  /** Whether a name has a value, cached or stored (a unit's `storage_units` row, an operational file on disk). */
  function known(file: string, onDisk: (file: string) => boolean): boolean {
    if (entries.has(file)) return true;
    const key = unitKeys.get(file);
    if (!key) return onDisk(file);
    const db = seam.db();
    return seam.run(
      () =>
        db.prepare('SELECT 1 AS ok FROM storage_units WHERE id = ? AND retired_at IS NULL').get(storageId(key)) !==
        undefined
    );
  }

  /**
   * Every id of the units under a `collection`, stored in the database or only cached (no side effects on the cache). A
   * name only addressed, never stored nor cached, is no unit.
   */
  function idsUnder(dir: string): Array<string> {
    const ids = new Set<string>();
    const query = directoryQueries.get(dir);
    const db = seam.db();
    if (!query) return [];
    const cachedKeys = [...unitKeys].filter(([name]) => entries.has(name)).map(([, key]) => key);
    const keys = [...seam.run(() => listUnits(db, query)).map((unit) => unit.key), ...cachedKeys];
    for (const key of keys) if (key.kind === query.kind && !key.selector && !key.partition) ids.add(key.subject.id);
    return [...ids];
  }

  /** The entry's whole value handed to the outbox (a JSON copy). With a database that has no writer the entry stays dirty. */
  function sendUnit(file: string, item: CacheItem): void {
    if (!outbox) {
      log.warn('store: unit write failed', { code: 'DB_CLOSED' });
      return;
    }
    outbox.value(ownerOf(file), JSON.parse(JSON.stringify(item.value)));
    item.dirty = false;
  }

  /**
   * Write one dirty entry: a unit to the outbox, a file atomically; a failed file write is logged and stays dirty for
   * the next flush. An entry held for the archive (`holdFlush` > 0) is skipped unless `force`.
   */
  function flushEntry(file: string, item: CacheItem, { force = false } = {}): FlushOutcome {
    if (!item.dirty) return 'clean';
    if (!force && (item.holdFlush ?? 0) > 0) return 'held';
    if (unitKeys.has(file)) {
      sendUnit(file, item);
      return 'written';
    }
    try {
      files.write(file, item.value);
      item.dirty = false;
      return 'written';
    } catch (err) {
      log.error('store: flush failed', { file, error: err });
      return 'failed';
    }
  }

  /** Every dirty entry flushed (`flushEntry`), and what waits sent on (not awaited); counts by outcome. */
  function flushAll({ force = false } = {}): { written: number; failed: number; held: number } {
    const counts = { written: 0, failed: 0, held: 0 };
    for (const [file, item] of entries) {
      const outcome = flushEntry(file, item, { force });
      if (outcome !== 'clean') counts[outcome] += 1;
    }
    if (outbox && outbox.size() > 0) void outbox.push();
    return counts;
  }

  /** The entry written at once: flushed and sent now, not at the next flush. */
  function writeNow(file: string, item: CacheItem): void {
    flushEntry(file, item);
    if (outbox) void outbox.push();
  }

  /**
   * Every cached entry dropped except `keep` and those the outbox still holds (`/nep pause`), so the next read takes
   * the stored value; returns how many went. A dropped entry with unflushed changes is logged.
   */
  function drop(keep: string): number {
    let dropped = 0;
    for (const [file, item] of entries) {
      if (file === keep) continue;
      if (item.dirty) log.warn('store: dropping a cache entry with unflushed changes', { file });
    }
    for (const file of [...entries.keys()]) {
      if (file === keep) continue;
      // An entry whose write has not resolved stays, so no later read takes the older value.
      if (holds(file)) continue;
      entries.delete(file);
      dropped += 1;
    }
    return dropped;
  }

  /** The entry read again from where it is stored, its unflushed change discarded (`/nep resume`). */
  function reload(file: string, item: CacheItem): void {
    const key = unitKeys.get(file);
    if (!key) item.value = files.read(file, {});
    else {
      const unit = seam.run(() => unitValue(seam.db(), key));
      item.value = unit.found ? unit.value : {};
    }
    item.dirty = false;
  }

  /**
   * Her session moved these people's attitude in the database (`[{ personId, applied }]`, any person id). Every cached
   * user unit of a moved person is dropped, or marked stale while it is dirty or its write is under way (see the head
   * of this file). Returns how many entries were dropped or marked.
   */
  function attitudeMoved(moves: Array<{ personId: string; applied?: number }>): number {
    if (!Array.isArray(moves)) return 0;
    let taken = 0;
    for (const move of moves) {
      for (const [file, item] of [...entries]) {
        const key = unitKeys.get(file);
        if (!key || key.kind !== 'user' || storageContext(seam.db(), key).subjectPersonId !== move.personId) continue;
        if (!item.dirty && !holds(file)) entries.delete(file);
        else item.stale = true;
        taken += 1;
      }
    }
    return taken;
  }

  // The database's other writer reaches the cached units (see the head of this file).
  if (typeof memoryDb.onAffinityMoves === 'function')
    memoryDb.onAffinityMoves((moves: Array<Record<string, unknown>>) =>
      attitudeMoved(moves as Array<{ personId: string }>)
    );

  return {
    address,
    collection,
    entry,
    /** The cached entry under `file`, without loading it. */
    cached: (file: string): CacheItem | undefined => entries.get(file),
    known,
    idsUnder,
    flushEntry,
    flushAll,
    writeNow,
    /** How many dirty entries the archive holds back from a flush. */
    held: (): number => [...entries.values()].filter((item) => item.dirty && (item.holdFlush ?? 0) > 0).length,
    /** Waits for the database to take what the flushes handed over (unit-outbox.ts#flush); how many still wait. */
    settle: async (): Promise<number | undefined> => (outbox ? await outbox.flush() : undefined),
    /** At shutdown: what still waits kept in `memory-pending/` (unit-outbox.ts#keep); how many. */
    keep: (): number | undefined => (outbox ? outbox.keep() : undefined),
    drop,
    reload,
    /** Whether a unit can be written: false with a closed writer. */
    writable: (): boolean => outbox !== null,
    /** Lines of a JSONL unit queued for the writer; false (nothing queued) when there is none. */
    lines(key: StorageKey, list: Array<unknown>): boolean {
      if (!outbox) return false;
      outbox.lines(key, list);
      return true;
    },
    /** What waits sent on now, not awaited. */
    push(): void {
      if (outbox) void outbox.push();
    },
    /** Whether a write of the unit or file waits or is under way. */
    holds: (owner: StorageKey | string): boolean =>
      outbox?.holds(typeof owner === 'string' ? ownerOf(owner) : owner) ?? false,
    attitudeMoved,
  };
}
