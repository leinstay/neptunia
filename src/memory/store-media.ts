// The store's way to the describer's cache (src/memory/store.ts builds one per store): each entry is a row of `media`,
// read by its key with one query and written as one row at once through the writer's `media-entry` kind
// (src/memory/db/media-store.ts). Nothing of the cache is kept in memory but the writes under way: a read in the tick of
// a write answers what was written, until the writer took it. A failed write stays under way and is sent again by the
// next write of the same key or by the store's flush; the shutdown waits for them (`settle`) and logs what it lost.
//
//   entry(placeId, key)            the entry under `key`, or undefined
//   entries(placeId, keys?)        the entries under `keys` that hold one, every entry of the cache without `keys`
//   saved(placeId, key)            the successful description `key` holds, also on a row the trim retired, or null
//   put(placeId, key, entry)       the entry written
//   drop(placeId, key)             the key dropped
//
// The cache of a place is the cache of the place's interface (`cacheIface`): the interface of its row, else the live
// interface of the service.

import { cacheIface, mediaCacheEntries, mediaCacheEntry, savedMediaDescription } from './db/media-store.ts';
import type { MediaDescriptionEntry } from './db/media-store.ts';
import { createWritesUnderWay } from './db/writes-under-way.ts';
import type { Db, Row } from './db/types.ts';
import type { MemoryDb } from './types.ts';
import { log } from '../log.ts';

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

/** One write under way: the entry it puts, or null for a drop. */
type Under = { placeId: string; key: string; entry: Row | null; sent: boolean };

/** What the store offers of the describer's cache (see the head of this file). */
export type StoreMedia = {
  entry: (placeId: string, key: string) => Row | undefined;
  entries: (placeId: string, keys?: Iterable<string>) => Record<string, Row>;
  saved: (placeId: string, key: string) => MediaDescriptionEntry | null;
  put: (placeId: string, key: string, entry: unknown) => void;
  drop: (placeId: string, key: string) => void;
  flush: () => void;
  settle: (options?: { final?: boolean; timeoutMs?: number }) => Promise<number>;
};

const nameOf = (placeId: string, key: string): string => `${placeId}\u0000${key}`;

/** The describer's cache over `memoryDb`, read through `seam`. */
export function createStoreMedia({ memoryDb, seam }: { memoryDb: MemoryDb; seam: Seam }): StoreMedia {
  const under = new Map<string, Under>();
  const writes = createWritesUnderWay({ log, name: 'media' });

  const ifaceOf = (placeId: string): string | null => cacheIface(seam.db(), placeId, memoryDb.namespace?.() ?? null);

  /** One write sent, unless the database takes none; it leaves `under` once it landed and nothing newer replaced it. */
  function send(name: string, item: Under): void {
    const write = memoryDb.writeMediaEntry;
    if (!write) return;
    item.sent = true;
    const given =
      item.entry === null
        ? { op: 'drop' as const, placeId: item.placeId, key: item.key }
        : { op: 'put' as const, placeId: item.placeId, key: item.key, entry: item.entry };
    writes.track(
      () =>
        write(given).then(() => {
          if (under.get(name) === item) under.delete(name);
        }),
      () => {
        item.sent = false;
      }
    );
  }

  function change(placeId: string, key: string, entry: Row | null): void {
    const name = nameOf(placeId, key);
    const item: Under = { placeId, key, entry, sent: false };
    under.set(name, item);
    send(name, item);
  }

  function resend(): void {
    for (const [name, item] of under) if (!item.sent) send(name, item);
  }

  const copy = (entry: Row): Row => structuredClone(entry);

  return {
    entry(placeId, key) {
      const pending = under.get(nameOf(placeId, key));
      if (pending) return pending.entry === null ? undefined : copy(pending.entry);
      return seam.run(() => mediaCacheEntry(seam.db(), { iface: ifaceOf(placeId), key }));
    },
    entries(placeId, keys) {
      const wanted = keys === undefined ? undefined : [...keys];
      const stored = seam.run(() => mediaCacheEntries(seam.db(), { iface: ifaceOf(placeId), keys: wanted }));
      for (const item of under.values()) {
        if (item.placeId !== placeId || (wanted && !wanted.includes(item.key))) continue;
        if (item.entry === null) delete stored[item.key];
        else stored[item.key] = copy(item.entry);
      }
      return stored;
    },
    saved(placeId, key) {
      const pending = under.get(nameOf(placeId, key));
      if (pending?.entry) return copy(pending.entry) as MediaDescriptionEntry;
      return seam.run(() => savedMediaDescription(seam.db(), { iface: ifaceOf(placeId), key }));
    },
    put(placeId, key, entry) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`media entry "${key}" is not an object; the cache keeps one object per key`);
      change(placeId, key, copy(entry as Row));
    },
    drop(placeId, key) {
      change(placeId, key, null);
    },
    flush: resend,
    settle: ({ final = false, timeoutMs } = {}) =>
      memoryDb.writeMediaEntry
        ? writes.drain({ final, timeoutMs, unwritten: () => under.size, resend })
        : Promise.resolve(0),
  };
}

/** The store's methods of the describer's cache, as the describer and the web lookup call them. */
export type MediaCachePort = {
  mediaEntry: (placeId: string, key: string) => Row | undefined;
  mediaEntries: (placeId: string, keys?: Iterable<string>) => Record<string, Row>;
  putMediaEntry: (placeId: string, key: string, entry: unknown) => void;
  dropMediaEntry: (placeId: string, key: string) => void;
};

/**
 * The describer's cache over one object of entries by key, for a run that works on a copy and writes nothing to the
 * database (scripts/replay.ts, a comparison script): every place reads and writes the same object.
 */
export function objectMediaCache(cache: Record<string, unknown>): MediaCachePort {
  const entryOf = (key: string): Row | undefined =>
    Object.hasOwn(cache, key) ? (cache[key] as Row | undefined) : undefined;
  return {
    mediaEntry: (_placeId, key) => entryOf(key),
    mediaEntries: (_placeId, keys) => {
      const out: Record<string, Row> = {};
      for (const key of keys ?? Object.keys(cache)) {
        const entry = entryOf(key);
        if (entry !== undefined) out[key] = entry;
      }
      return out;
    },
    putMediaEntry: (_placeId, key, entry: unknown) => {
      delete cache[key];
      cache[key] = entry;
    },
    dropMediaEntry: (_placeId, key) => {
      delete cache[key];
    },
  };
}
