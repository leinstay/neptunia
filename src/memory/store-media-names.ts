// The store's stable names of custom emoji and stickers (src/memory/store.ts builds one per store), over the table
// `media_names` (src/memory/db/media-names.ts). The rows are read once and kept for the life of the store. `nameMedia`
// answers at once: a known thing keeps its name, a new one gets the next number of its kind (`e` for an emoji, `s` for
// a sticker), and every new or changed row goes to the writer's `media-names` kind. A failed write is sent again by the
// next flush; the shutdown waits for it (`settle`) and logs what it lost.

import { mediaNameRows } from './db/media-names.ts';
import type { MediaNameRow } from './db/media-names.ts';
import { createWritesUnderWay } from './db/writes-under-way.ts';
import type { Db } from './db/types.ts';
import type { MemoryDb } from './types.ts';
import { log } from '../log.ts';

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

/** A named custom emoji or sticker. */
export type MediaName = MediaNameRow;
/** A thing as an interface shows it, before it has a name. */
export type MediaNameItem = { nativeId: string; platformName: string; animated: boolean };

/** What the store offers of the stable names (see the head of this file). */
export type StoreMediaNames = {
  nameMedia: (iface: string, kind: 'emoji' | 'sticker', items: ReadonlyArray<MediaNameItem>) => Array<MediaName>;
  mediaNameOf: (name: string) => MediaName | null;
  mediaNameFor: (iface: string, kind: 'emoji' | 'sticker', nativeId: string) => MediaName | null;
  flush: () => void;
  settle: (options?: { final?: boolean; timeoutMs?: number }) => Promise<number>;
};

const PREFIX = { emoji: 'e', sticker: 's' } as const;
const keyOf = (iface: string, kind: string, nativeId: string): string => JSON.stringify([iface, kind, nativeId]);

/** The stable names over `memoryDb`, read through `seam`. */
export function createStoreMediaNames({ memoryDb, seam }: { memoryDb: MemoryDb; seam: Seam }): StoreMediaNames {
  const writes = createWritesUnderWay({ log, name: 'media-names' });
  let byName: Map<string, MediaName> | null = null;
  const byThing = new Map<string, MediaName>();
  const highest = { emoji: 0, sticker: 0 };
  // The rows the database does not hold yet, by name.
  const unwritten = new Map<string, MediaName>();

  function loaded(): Map<string, MediaName> {
    if (byName) return byName;
    byName = new Map();
    for (const row of seam.run(() => mediaNameRows(seam.db()))) remember(row);
    return byName;
  }

  function remember(row: MediaName): void {
    loaded().set(row.name, row);
    byThing.set(keyOf(row.iface, row.kind, row.nativeId), row);
    const number = Number(row.name.slice(1));
    if (Number.isInteger(number) && number > highest[row.kind]) highest[row.kind] = number;
  }

  function send(): void {
    // A read-only handle (scripts/lib/turn-wiring.ts) has no writer: its names stay unwritten.
    const write = memoryDb.writeMediaNames;
    if (!write || unwritten.size === 0) return;
    const rows = [...unwritten.values()];
    unwritten.clear();
    writes.track(
      () => write({ rows }),
      () => {
        for (const row of rows) if (!unwritten.has(row.name)) unwritten.set(row.name, row);
      }
    );
  }

  function nameMedia(iface: string, kind: 'emoji' | 'sticker', items: ReadonlyArray<MediaNameItem>): Array<MediaName> {
    loaded();
    const named = items.map((item) => {
      const held = byThing.get(keyOf(iface, kind, item.nativeId));
      if (held && held.platformName === item.platformName && held.animated === item.animated) return held;
      const name = held?.name ?? `${PREFIX[kind]}${highest[kind] + 1}`;
      const row: MediaName = { name, kind, iface, ...item };
      remember(row);
      unwritten.set(name, row);
      return row;
    });
    send();
    return named.map((row) => ({ ...row }));
  }

  return {
    nameMedia,
    mediaNameOf: (name) => {
      const row = loaded().get(name);
      return row ? { ...row } : null;
    },
    mediaNameFor: (iface, kind, nativeId) => {
      loaded();
      const row = byThing.get(keyOf(iface, kind, nativeId));
      return row ? { ...row } : null;
    },
    flush: send,
    settle: ({ final = false, timeoutMs } = {}) =>
      memoryDb.writeMediaNames
        ? writes.drain({ final, timeoutMs, unwritten: () => unwritten.size, resend: send })
        : Promise.resolve(0),
  };
}
