// The store's reads and writes of the memory database (src/memory/store.ts builds one per store). A value is one unit
// of the database, named by `address(key)`. `entry` reads it from the database and keeps it only while it is in use:
// for the rest of the tick that read it, so two reads of one unit in one synchronous change share one object, and while
// it is changed, held for the archive or its write is under way, so a read never takes an older value than the store
// wrote. A change is marked by setting `dirty`, and at the end of the tick its whole value goes straight to the writer,
// at most one write per unit under way: a change made meanwhile goes once that write settled. A failed write leaves the
// value changed and in use, and the next `flushAll` (the store's timer) sends it again.
//
// A value nothing changed goes out of use at the end of the tick, so the next read takes what the database holds,
// whoever wrote it. That read is answered from the last read of the same unit while no other writer reached a unit's
// rows since (`stampOf`: the service's `writeGeneration()`), and read again after one. A value the store sent is that
// last read, stamped with the moment it was read, so a write of another writer that landed while it was in use still
// sends the next read to the database.
//
// `holdFlush` above zero keeps a changed value from the writer until the archive took the versions it replaced
// (store.ts, "The archive"). `lines(key, list)` appends lines to a unit, in their order. `settle({ final, timeoutMs })`
// waits for the writes under way: with `final` (the shutdown) a write that still fails is logged as lost, and the wait
// ends after `timeoutMs`, logged as `store: writes still under way at shutdown` with their count.

import { accountProfileOfUnit } from './db/account-profile.ts';
import { channelEntryOfUnit } from './db/channel-entry.ts';
import { operationalOfUnit } from './db/operational.ts';
import { participationOfUnit } from './db/participation-episodes.ts';
import { placeLoreOfUnit } from './db/place-lore.ts';
import { placeNotesOfUnit } from './db/place-notes.ts';
import { privateLayerOfUnit } from './db/private-layer.ts';
import { proseVersionsOfUnit } from './db/prose-versions.ts';
import { unitValue } from './db/readers/common.ts';
import { recentLinesOfUnit } from './db/recent-lines.ts';
import { selfreflectionOfUnit } from './db/selfreflection-entries.ts';
import { keyText, storageId } from './db/storage-keys.ts';
import type { StorageKey, StorageKind } from './db/storage-keys.ts';
import { listUnits } from './db/storage-units.ts';
import type { UnitQuery } from './db/storage-units.ts';
import type { Db, Row } from './db/types.ts';
import type { MemoryDb, Untyped } from './types.ts';
import { log } from '../log.ts';

/** A value in use: its parsed value, whether it waits for its write, and the holds on that write. */
export type StoreItem = { value: Untyped; dirty: boolean; holdFlush?: number };

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };
/** One unit's way to the writer: the write under way, and the lines waiting behind it. */
type Lane = { sending: Promise<void> | null; lines: Array<unknown> };

/** The direct writes of the service, in the order a unit is matched against them, each with its unit's write. */
const DIRECT_WRITES: ReadonlyArray<[keyof MemoryDb, (update: Row) => object | null]> = [
  ['writeOperational', operationalOfUnit],
  ['writeAccountProfile', accountProfileOfUnit],
  ['writeProseVersions', proseVersionsOfUnit],
  ['writePrivateLayer', privateLayerOfUnit],
  ['writePlaceNotes', placeNotesOfUnit],
  ['writeChannelEntry', channelEntryOfUnit],
  ['writePlaceLore', placeLoreOfUnit],
  ['writeParticipation', participationOfUnit],
  ['writeRecentLines', recentLinesOfUnit],
  ['writeSelfreflection', selfreflectionOfUnit],
];

/** The write of one unit: the direct write of its kind; a unit no kind takes is refused with `UNIT_UNMAPPED`. */
function writeOf(memoryDb: MemoryDb, update: Row): Promise<unknown> {
  for (const [method, directOf] of DIRECT_WRITES) {
    // Each method takes the write its own `directOf` gives; the table pairs them.
    const write = memoryDb[method] as ((this: void, given: object) => Promise<unknown>) | undefined;
    const direct = write ? directOf(update) : null;
    if (write && direct) return write(direct);
  }
  return Promise.reject(Object.assign(new Error('UNIT_UNMAPPED'), { code: 'UNIT_UNMAPPED' }));
}

/** Whether a service takes the store's writes: it has the direct write of every kind the store sends. */
const takesWrites = (memoryDb: MemoryDb): boolean =>
  DIRECT_WRITES.every(([method]) => typeof memoryDb[method] === 'function');

/** What a store asks of its reads and writes (see the head of this file). */
export type StoreWrites = {
  address: (key: StorageKey) => string;
  collection: (kind: StorageKind) => string;
  entry: (file: string, fallback: () => unknown) => StoreItem;
  pin: (file: string, fallback: () => unknown) => StoreItem;
  inUse: (file: string) => StoreItem | undefined;
  known: (file: string) => boolean;
  idsUnder: (dir: string) => Array<string>;
  flushAll: (options?: { force?: boolean }) => { written: number; failed: number; held: number };
  writeNow: (file: string, item: StoreItem) => void;
  held: () => number;
  settle: (options?: { final?: boolean; timeoutMs?: number }) => Promise<number>;
  drop: (keep: string) => number;
  reload: (file: string, item: StoreItem) => void;
  writable: () => boolean;
  lines: (key: StorageKey, list: Array<unknown>) => boolean;
  push: () => void;
  holds: (owner: StorageKey | string) => boolean;
};

/** The reads and writes over `memoryDb`, reading through `seam`. See the head of this file. */
// health: allow function-length until 2027-04-01 -- one closure over the values in use and their writes
export function createStoreWrites({ memoryDb, seam }: { memoryDb: MemoryDb; seam: Seam }): StoreWrites {
  const writer: MemoryDb | null = takesWrites(memoryDb) ? memoryDb : null;
  const inUse = new Map<string, StoreItem>();
  // The values kept for the whole life of the store (her state, the GIF library, a place's media cache).
  const pinned = new Set<string>();
  const lanes = new Map<string, Lane>();
  const unitKeys = new Map<string, StorageKey>();
  const directoryQueries = new Map<string, UnitQuery>();
  // The last read of each unit with the stamp it was read at (`stampOf`).
  const lastRead = new Map<string, { stamp: string; found: boolean; value: unknown }>();
  // The stamp each value in use was read at.
  const readAt = new WeakMap<StoreItem, string>();
  // The values whose last write failed: changed again without waking the sweep, sent by the next `flushAll`.
  const failed = new WeakSet<StoreItem>();
  let lastCode: unknown = null;
  let swept = true;

  /** The name of a unit, registered so its write goes to the database. */
  function address(key: StorageKey): string {
    const name = keyText(key);
    unitKeys.set(name, key);
    return name;
  }

  /** The name of a directory of units (`idsUnder`). */
  function collection(kind: StorageKind): string {
    const name = JSON.stringify({ kind });
    directoryQueries.set(name, { kind });
    return name;
  }

  const laneOf = (file: string): Lane => {
    let lane = lanes.get(file);
    if (!lane) {
      lane = { sending: null, lines: [] };
      lanes.set(file, lane);
    }
    return lane;
  };
  const holds = (file: string): boolean => {
    const lane = lanes.get(file);
    return Boolean(lane && (lane.sending || lane.lines.length > 0));
  };

  /** The end of the tick runs `sweep` once, however many values changed in it. */
  function wake(): void {
    if (!swept) return;
    swept = false;
    queueMicrotask(sweep);
  }

  /**
   * A value in use whose `dirty` and `holdFlush` wake the sweep when set. A value changed after it went out of use (a
   * caller kept it over an await) comes back into use, so its change is written.
   */
  function itemOf(file: string, value: unknown): StoreItem {
    let dirty = false;
    let holdFlush = 0;
    const adopt = (): void => {
      if (inUse.get(file) !== item) inUse.set(file, item);
      wake();
    };
    const item: StoreItem = {
      value,
      get dirty(): boolean {
        return dirty;
      },
      // Clearing it wakes nothing: a write handed over or a value read again.
      set dirty(next: boolean) {
        dirty = next;
        if (next) adopt();
      },
      get holdFlush(): number {
        return holdFlush;
      },
      set holdFlush(next: number) {
        holdFlush = next;
        if (next > 0) adopt();
        else wake();
      },
    };
    return item;
  }

  /** The stored value of `file`, or `fallback()` for a unit nobody stored, with the stamp it was read at. */
  function stored(file: string, fallback: () => unknown): { value: unknown; stamp: string } {
    const stamp = stampOf();
    const key = unitKeys.get(file);
    if (!key) return { value: fallback(), stamp };
    const last = lastRead.get(file);
    if (last && last.stamp === stamp) return { value: last.found ? last.value : fallback(), stamp };
    const unit = seam.run(() => unitValue(seam.db(), key));
    lastRead.set(file, unit.found ? { stamp, found: true, value: unit.value } : { stamp, found: false, value: null });
    return { value: unit.found ? unit.value : fallback(), stamp };
  }

  /**
   * How many writes of other writers reached a unit's rows (the service's `writeGeneration()`); a read is answered
   * from the last read of its unit only while it is equal. A database without it is read anew every time.
   */
  let unstamped = 0;
  function stampOf(): string {
    if (typeof memoryDb.writeGeneration === 'function') return String(memoryDb.writeGeneration());
    unstamped += 1;
    return `read:${unstamped}`;
  }

  /** The value in use under `file`, else the database's (`fallback()` for a unit nobody stored), in use to the tick's end. */
  function entry(file: string, fallback: () => unknown): StoreItem {
    let item = inUse.get(file);
    if (!item) {
      const read = stored(file, fallback);
      item = itemOf(file, read.value);
      readAt.set(item, read.stamp);
      inUse.set(file, item);
      wake();
    }
    return item;
  }

  /** `entry` kept for the life of the store. */
  function pin(file: string, fallback: () => unknown): StoreItem {
    pinned.add(file);
    return entry(file, fallback);
  }

  /** Whether a name has a value, in use or stored (a unit's `storage_units` row). */
  function known(file: string): boolean {
    if (inUse.has(file)) return true;
    const key = unitKeys.get(file);
    if (!key) return false;
    const db = seam.db();
    return seam.run(
      () =>
        db.prepare('SELECT 1 AS ok FROM storage_units WHERE id = ? AND retired_at IS NULL').get(storageId(key)) !==
        undefined
    );
  }

  /** Every id of the units under a `collection`, stored or in use. */
  function idsUnder(dir: string): Array<string> {
    const query = directoryQueries.get(dir);
    if (!query) return [];
    const db = seam.db();
    const usedKeys = [...unitKeys].filter(([name]) => inUse.has(name)).map(([, key]) => key);
    const ids = new Set<string>();
    for (const key of [...seam.run(() => listUnits(db, query)).map((unit) => unit.key), ...usedKeys])
      if (key.kind === query.kind && !key.selector && !key.partition) ids.add(key.subject.id);
    return [...ids];
  }

  /** The update of a unit as the writer takes it: its whole value, or lines to append. */
  function updateOf(file: string, body: { value: unknown } | { lines: Array<unknown> }): Row {
    const key = unitKeys.get(file);
    const target = key ? { key } : { owner: file };
    return 'value' in body
      ? { op: 'value', ...target, value: body.value }
      : { op: 'lines', ...target, lines: body.lines };
  }

  /** The write of one unit started on its lane; `after` runs once it settled, with whether it landed. */
  function start(file: string, update: Row, after: (landed: boolean) => void): void {
    if (!writer) return;
    const lane = laneOf(file);
    const sending: Promise<void> = Promise.resolve()
      .then(() => writeOf(writer, update))
      .then(
        () => true,
        (error: unknown) => {
          lastCode = (error as { code?: unknown } | null)?.code ?? null;
          log.warn('memory db: unit write failed', { reader: 'store', units: 1, code: lastCode });
          return false;
        }
      )
      .then((landed) => {
        if (lane.sending === sending) lane.sending = null;
        after(landed);
        next(file);
      });
    lane.sending = sending;
  }

  /** What waits on the unit's lane once its write settled: lines behind it, or a change made meanwhile. */
  function next(file: string): void {
    const lane = lanes.get(file);
    if (!lane || lane.sending) return;
    if (lane.lines.length > 0) {
      sendLines(file);
      return;
    }
    const item = inUse.get(file);
    if (item && !failed.has(item)) send(file, item);
    if (!lane.sending) {
      lanes.delete(file);
      release();
    }
  }

  /** The lines waiting on the unit's lane sent, unless a write of the unit is under way; a failed write puts them back. */
  function sendLines(file: string): void {
    const lane = lanes.get(file);
    if (!lane || lane.sending || lane.lines.length === 0) return;
    const list = lane.lines.splice(0);
    start(file, updateOf(file, { lines: list }), (landed) => {
      if (!landed) lane.lines.unshift(...list);
    });
  }

  /**
   * One changed value sent (a JSON copy) when no write of the unit is under way; true when it was sent or waits behind
   * the write under way. Without a writer it stays changed.
   */
  function send(file: string, item: StoreItem, { force = false } = {}): boolean {
    if (!item.dirty || (!force && (item.holdFlush ?? 0) > 0)) return false;
    if (!writer) {
      log.warn('store: unit write failed', { code: 'DB_CLOSED' });
      return false;
    }
    if (holds(file)) return true;
    const value: unknown = JSON.parse(JSON.stringify(item.value));
    // The value as written is what the next read answers until another writer reaches a unit's rows: the ids a read
    // gave the items of her session stay the ones the store wrote with.
    lastRead.set(file, { stamp: readAt.get(item) ?? '', found: true, value: item.value });
    item.dirty = false;
    failed.delete(item);
    start(file, updateOf(file, { value }), (landed) => {
      if (landed || item.dirty) return;
      // Changed again without waking the sweep: the next flush sends it.
      failed.add(item);
      item.dirty = true;
    });
    return true;
  }

  /** The values no change, hold or write keeps, out of use. */
  function release(): void {
    for (const [file, item] of inUse) {
      if (pinned.has(file) || item.dirty || (item.holdFlush ?? 0) > 0 || holds(file)) continue;
      inUse.delete(file);
    }
  }

  /** The end of a tick: every changed value that did not just fail sent, then what nothing keeps out of use. */
  function sweep(): void {
    swept = true;
    for (const [file, item] of inUse) if (item.dirty && !failed.has(item)) send(file, item);
    release();
  }

  /** Every changed value sent (held ones only with `force`), and the waiting lines; counts by outcome. */
  function flushAll({ force = false } = {}): { written: number; failed: number; held: number } {
    const counts = { written: 0, failed: 0, held: 0 };
    for (const [file, item] of inUse) {
      if (!item.dirty) continue;
      failed.delete(item);
      if (!force && (item.holdFlush ?? 0) > 0) counts.held += 1;
      else if (send(file, item, { force })) counts.written += 1;
      else counts.failed += 1;
    }
    for (const file of lanes.keys()) sendLines(file);
    release();
    return counts;
  }

  /** How many units have a write under way, lines waiting, or a change not written yet. */
  function unwritten(): number {
    const files = new Set([...lanes.keys()].filter(holds));
    for (const [file, item] of inUse) if (item.dirty && (item.holdFlush ?? 0) === 0) files.add(file);
    return files.size;
  }

  /** The writes under way settled. */
  const underWay = (): Promise<unknown> =>
    Promise.allSettled([...lanes.values()].flatMap((lane) => (lane.sending ? [lane.sending] : [])));

  /** Sends and awaits until nothing waits, or a round brought nothing through; how many units still wait. */
  async function drain(): Promise<number> {
    for (let round = 0; round < 3; round += 1) {
      await underWay();
      if (unwritten() === 0) break;
      const before = unwritten();
      flushAll();
      await underWay();
      if (unwritten() >= before) break;
    }
    return unwritten();
  }

  /**
   * Waits for the writes under way; how many still wait. With `final` (the shutdown) what still fails is logged as
   * lost, and with `timeoutMs` too the wait ends after it, logged with the count.
   */
  async function settle({ final = false, timeoutMs }: { final?: boolean; timeoutMs?: number } = {}): Promise<number> {
    if (!writer) return 0;
    const draining = drain();
    let waiting: number | null;
    if (final && typeof timeoutMs === 'number' && timeoutMs >= 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      waiting = await Promise.race([draining, late]);
      clearTimeout(timer);
      if (waiting === null) {
        const units = unwritten();
        log.error('store: writes still under way at shutdown', { units, ms: timeoutMs });
        return units;
      }
    } else waiting = await draining;
    if (final && waiting > 0) log.error('memory db: units lost', { reader: 'store', units: waiting, code: lastCode });
    release();
    return waiting;
  }

  /** Every value out of use except `keep` and those whose write is under way (`/nep pause`); how many went. */
  function drop(keep: string): number {
    lastRead.clear();
    let dropped = 0;
    for (const [file, item] of [...inUse]) {
      if (file === keep || holds(file)) continue;
      if (item.dirty) log.warn('store: dropping a value with unwritten changes', { file });
      inUse.delete(file);
      dropped += 1;
    }
    return dropped;
  }

  /** The value read again from the database, its unwritten change discarded (`/nep resume`). */
  function reload(file: string, item: StoreItem): void {
    lastRead.delete(file);
    const read = stored(file, () => ({}));
    item.value = read.value;
    readAt.set(item, read.stamp);
    item.dirty = false;
  }

  return {
    address,
    collection,
    entry,
    pin,
    /** The value in use under `file`, without reading it. */
    inUse: (file: string): StoreItem | undefined => inUse.get(file),
    known,
    idsUnder,
    flushAll,
    /** The value sent now, not at the end of the tick. */
    writeNow(file: string, item: StoreItem): void {
      send(file, item);
    },
    /** How many changed values the archive holds back. */
    held: (): number => [...inUse.values()].filter((item) => item.dirty && (item.holdFlush ?? 0) > 0).length,
    settle,
    drop,
    reload,
    /** Whether a unit can be written: false without a writer. */
    writable: (): boolean => writer !== null,
    /** Lines appended to a unit, sent behind any write of it under way; false (nothing queued) without a writer. */
    lines(key: StorageKey, list: Array<unknown>): boolean {
      if (!writer) return false;
      if (list.length === 0) return true;
      laneOf(address(key)).lines.push(...list);
      return true;
    },
    /** The waiting lines sent now. */
    push(): void {
      for (const file of lanes.keys()) sendLines(file);
    },
    /** Whether a write of the unit is under way or lines of it wait. */
    holds: (owner: StorageKey | string): boolean => holds(typeof owner === 'string' ? owner : keyText(owner)),
  };
}
