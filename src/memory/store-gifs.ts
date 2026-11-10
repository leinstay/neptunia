// The store's GIF library (src/memory/store.ts builds one per store): the library of src/memory/gifs.ts, read from its
// rows once (src/memory/db/gif-library.ts#gifLibraryValue) and kept for the life of the store, since every place and
// turn reads it. A change replaces the value, and at the end of the tick the entries it put and the keys it dropped go to
// the writer's `gif-library` kind, with the rest of the library when that changed; never the whole library. What the
// store knows the database holds is kept as one JSON text per entry, so the next write sends only what differs from it.
//
// Reading writes nothing, even when the stored library reads back normalised. One write is under way at a time: a
// change made meanwhile goes once it settled. A failed write leaves the database's
// side as it was, so the next change or the store's flush sends the same entries again; the shutdown waits for it
// (`settle`) and logs what it lost.

import { emptyGifs, normalizeGifs } from './gifs.ts';
import type { GifLibrary } from './gifs.ts';
import { gifLibraryValue } from './db/gif-library.ts';
import type { GifLibraryWrite } from './db/gif-library.ts';
import { createWritesUnderWay } from './db/writes-under-way.ts';
import type { Db } from './db/types.ts';
import type { MemoryDb } from './types.ts';
import { log } from '../log.ts';

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

/** What the database holds as far as the store knows: each entry's JSON by key, and the rest's JSON. */
type Held = { entries: Map<string, string>; rest: string | null };

/** What the store offers of the GIF library (see the head of this file). */
export type StoreGifs = {
  library: () => GifLibrary;
  set: (next: GifLibrary) => void;
  flush: () => void;
  settle: (options?: { final?: boolean; timeoutMs?: number }) => Promise<number>;
};

/** The JSON text of a value with every object's keys in order, so two equal entries read alike however they were built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, given: unknown) =>
    given !== null && typeof given === 'object' && !Array.isArray(given)
      ? Object.fromEntries(Object.entries(given).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : given
  );
}

/** What `library` holds that differs from `held`, and what the database holds once it is written; null for nothing. */
function changesOf(library: GifLibrary, held: Held): { write: GifLibraryWrite; after: Held } | null {
  const entries = new Map<string, string>();
  const put: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(library.entries)) {
    const text = canonical(entry);
    entries.set(key, text);
    if (held.entries.get(key) !== text) put[key] = entry;
  }
  const drop = [...held.entries.keys()].filter((key) => !entries.has(key));
  const others = { nextId: library.nextId, backfill: library.backfill, backfills: library.backfills };
  const rest = canonical(others);
  const restChanged = rest !== held.rest;
  if (Object.keys(put).length === 0 && drop.length === 0 && !restChanged) return null;
  return {
    write: {
      ...(Object.keys(put).length > 0 ? { put } : {}),
      ...(drop.length > 0 ? { drop } : {}),
      ...(restChanged ? { rest: others } : {}),
    },
    after: { entries, rest },
  };
}

/** The GIF library over `memoryDb`, read through `seam`. */
export function createStoreGifs({ memoryDb, seam }: { memoryDb: MemoryDb; seam: Seam }): StoreGifs {
  const writes = createWritesUnderWay({ log, name: 'gifs' });
  let value: GifLibrary | null = null;
  let held: Held = { entries: new Map(), rest: null };
  let sending = false;
  let scheduled = false;
  // How many changes were made, and how many of them the database holds: nothing is written before the first change.
  let changes = 0;
  let landed = 0;

  /** The library as the database holds it, normalised; what it held as read is what the store knows of it. */
  function load(): GifLibrary {
    const read = seam.run(() => gifLibraryValue(seam.db()));
    if (!read.found) return emptyGifs();
    const { entries, ...rest } = read.value;
    const stored = entries !== null && typeof entries === 'object' ? (entries as Record<string, unknown>) : {};
    held = {
      entries: new Map(Object.entries(stored).map(([key, entry]) => [key, canonical(entry)])),
      rest: canonical(rest),
    };
    return normalizeGifs(read.value);
  }

  /** The changes since what the database holds, sent unless a write is under way or the database takes none. */
  function send(): void {
    scheduled = false;
    const write = memoryDb.writeGifLibrary;
    if (!write || sending || value === null || landed === changes) return;
    const sent = changes;
    const found = changesOf(value, held);
    if (!found) {
      landed = sent;
      return;
    }
    sending = true;
    writes.track(
      () =>
        write(found.write).then(() => {
          held = found.after;
          landed = sent;
          sending = false;
          send();
        }),
      () => {
        sending = false;
      }
    );
  }

  return {
    library() {
      value ??= load();
      return value;
    },
    set(next) {
      value = next;
      changes += 1;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(send);
    },
    flush: send,
    settle: ({ final = false, timeoutMs } = {}) =>
      memoryDb.writeGifLibrary
        ? writes.drain({
            final,
            timeoutMs,
            unwritten: () => (landed === changes ? 0 : 1),
            resend: send,
          })
        : Promise.resolve(0),
  };
}
