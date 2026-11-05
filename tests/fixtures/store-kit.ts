// The helpers of the store tests: a memory database over a temporary data directory, the unit files it holds, an archive stand-in and the writers' lines of a channel.
import { placeOfConversation } from '../../src/memory/addresses.ts';
import { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './tmp.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { unitValue } from '../../src/memory/db/readers/common.ts';
import { topPlaceSpelled } from '../../src/memory/db/ids.ts';
import type { StorageKey } from '../../src/memory/db/storage-keys.ts';
import { legacyStorageKey } from '../../src/memory/migration/paths.ts';
import { asRecord } from './records.ts';
import type { MemoryDbService } from '../../src/memory/db/service.ts';
import type { createStore } from '../../src/memory/store.ts';
import type { Untyped } from '../../src/tools/types.ts';

export function tmpDataDir(): string {
  return tempDir('nep-store-');
}

export const SILENT: { info: () => void; debug: () => void; warn: () => void; error: () => void } = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};
/** The memory databases opened here, by data directory; closed once the file is done. */
export const MEMORY_OF = new Map<string, MemoryDbService>();
after(async () => {
  for (const memoryDb of MEMORY_OF.values()) await memoryDb.close();
});

/**
 * A temporary data directory with its memory database open on the calling thread (the first tick opens it at once):
 * `{ dir, memoryDb }`, the `memoryDb` the store takes.
 */
export function memDataDir(): { dir: string; memoryDb: MemoryDbService; } {
  const dir = tmpDataDir();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir: dir,
    log: SILENT,
    worker: false,
  });
  memoryDb.tick();
  if (!memoryDb.readHandle()) throw new Error('the test memory database did not open');
  MEMORY_OF.set(dir, memoryDb);
  return { dir, memoryDb };
}

/** Stores `channel` under the top place `top`, as the observation of its first line does. */
export function underTop(memoryDb: MemoryDbService, top: string, channel: string): void {
  const db = memoryDb.database() as unknown as { prepare(sql: string): { run(...args: Array<unknown>): unknown } };
  db.prepare("INSERT OR IGNORE INTO places (id, iface, kind) VALUES (?, 'discord', 'server')").run(top);
  db.prepare('UPDATE places SET parent_id = ? WHERE id = ?').run(top, channel);
}

/** One turn of the event loop: the unit writes a flush handed to the database have run. */
export const settle = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

/** The value the database holds for the memory unit `rel` (its path under data/), or undefined. */
export function unitOf(memoryDb: MemoryDbService, rel: string): Untyped {
  const handle = memoryDb.readHandle();
  if (!handle) throw new Error('the test memory database is not open');
  return asRecord(unitValue(handle.db, keyOfRel(rel)))?.value;
}

/** The value of the unit `rel` as JSON text (a byte check of "nothing was written"). */
export function unitText(memoryDb: MemoryDbService, rel: string): string {
  return JSON.stringify(unitOf(memoryDb, rel));
}

/**
 * The unit a file path of a shipped layout names, under the place a fresh database spells for that server: the store asks
 * for that spelling when no row holds the server yet (src/memory/store-addresses.ts#placeOfCommunity).
 */
export function keyOfRel(rel: string): StorageKey {
  const key = legacyStorageKey(rel);
  const native = /^discord:guild:(.+)$/.exec(key.subject.id)?.[1];
  return native === undefined ? key : { ...key, subject: { ...key.subject, id: topPlaceSpelled('discord', native) } };
}

/** Writes `value` as the memory unit `rel`, as a hand edit or an older engine left it. */
export function putUnit(
  memoryDb: MemoryDbService,
  rel: string,
  value: unknown
): ReturnType<MemoryDbService['writeUnit']> {
  return memoryDb.writeUnit({ op: 'value', key: keyOfRel(rel), value });
}

export const WRITERS_DAY_MS = 24 * 60 * 60 * 1000;
export const WRITERS_T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
export const AGORA_FACTS = { name: 'αγορά', category: null, topic: null };

/** `count` messages of one writer in a channel, a millisecond apart from `fromTs`; the channel after the last. */
export function writeLines(
  store: Pick<ReturnType<typeof createStore>, 'touchChannel'>,
  placeId: string,
  authorId: string,
  count: number,
  fromTs: number,
  opts?: Parameters<ReturnType<typeof createStore>['touchChannel']>[4]
): Record<string, Untyped> {
  let channel: object | undefined;
  for (let n = 0; n < count; n += 1)
    channel = store.touchChannel(placeOfConversation(store, { id: placeId }), AGORA_FACTS, fromTs + n, authorId, opts);
  return channel as Record<string, Untyped>;
}

/** A channel file as the store wrote it before the tally existed. */
export function writeOldChannelFile(
  dir: string,
  placeId: string,
  fields: Record<string, unknown> = {}
): { file: string; old: Record<string, unknown>; raw: string } {
  const file = path.join(dir, 'guilds', 'g1', 'channels', `${placeId}.json`);
  const old = {
    id: placeId,
    name: 'αγορά',
    category: null,
    topic: null,
    purpose: 'κουβέντα',
    topics: '',
    tone: '',
    days: { '2026-06-01': 25 },
    messageCount: 25,
    firstMessageAt: WRITERS_T0,
    lastMessageAt: WRITERS_T0 + 5000,
    topWriters: [
      { id: 'άλφα', count: 9 },
      { id: 'βήτα', count: 7 },
      { id: 'γάμα', count: 5 },
      { id: 'δέλτα', count: 3 },
      { id: 'έψιλον', count: 1 },
    ],
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...fields,
  };
  writeRaw(file, old);
  return { file, old, raw: readRaw(file) };
}

/** The data directory with a database that `file` lies in, as `[dir, memoryDb, rel]`, else null. */
export function memoryFileOf(file: string): [string, MemoryDbService, string] | null {
  for (const [dir, memoryDb] of MEMORY_OF) {
    if (file.startsWith(dir + path.sep)) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      if (!/^(?:state|usage|metrics)\.json$/.test(rel)) return [dir, memoryDb, rel];
    }
  }
  return null;
}

/** `file` as text: a memory unit as its value's JSON, any other file from the disk. */
export function readRaw(file: string): string {
  const found = memoryFileOf(file);
  return found ? unitText(found[1], found[2]) : fs.readFileSync(file, 'utf8');
}

/** Whether `file` is there: a memory unit in the database, any other file on the disk. */
export function existsRaw(file: string): boolean {
  const found = memoryFileOf(file);
  return found ? unitOf(found[1], found[2]) !== undefined : fs.existsSync(file);
}

/** `value` as `file`: a memory unit of a data directory with a database goes into it, any other file to the disk. */
export function writeRaw(file: string, value: unknown): unknown {
  const found = memoryFileOf(file);
  if (found) return putUnit(found[1], found[2], value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value)); // compact: a flush would rewrite it pretty-printed
  return null;
}

type ArchiveCall = { placeId: string; entries: Array<unknown>; opts: Record<string, unknown> };
type PendingEntry = { placeId: string; entry: unknown; opts: Record<string, unknown> };

/** An archive stand-in: what was appended or queued; with `manual`, `append` resolves when released. */
export function fakeArchive({ manual = false, fail = false }: { manual?: boolean; fail?: boolean } = {}): {
  appended: Array<ArchiveCall>;
  pending: Array<PendingEntry>;
  events: Array<string>;
  fail: boolean;
  releases: Array<() => void>;
  append(placeId: string, entries: Array<unknown>, opts?: Record<string, unknown>): Promise<{ written: number; duplicates: number }>;
  queuePending(placeId: string, entries: Array<unknown>, opts?: Record<string, unknown>): Promise<number>;
  drainPending(): Promise<{ archived: number; left: number; confirmed: Array<unknown> }>;
  stats(): { pending: number };
} {
  const fake = {
    appended: [] as Array<ArchiveCall>,
    pending: [] as Array<PendingEntry>,
    events: [] as Array<string>,
    fail,
    releases: [] as Array<() => void>,
    append(placeId: string, entries: Array<unknown>, opts: Record<string, unknown> = {}) {
      fake.appended.push({ placeId, entries, opts });
      if (fake.fail) return Promise.reject(Object.assign(new Error('disk refused'), { code: 'archive-unconfirmed' }));
      const result = { written: entries.length, duplicates: 0 };
      if (!manual) return Promise.resolve(result);
      return new Promise<{ written: number; duplicates: number }>((resolve) => {
        fake.releases.push(() => {
          fake.events.push('append-resolved');
          resolve(result);
        });
      });
    },
    queuePending(placeId: string, entries: Array<unknown>, opts: Record<string, unknown> = {}) {
      fake.pending.push(...entries.map((entry) => ({ placeId, entry, opts })));
      return Promise.resolve(entries.length);
    },
    drainPending() {
      const confirmed = fake.pending.splice(0).map((item) => item.entry);
      return Promise.resolve({ archived: confirmed.length, left: 0, confirmed });
    },
    stats() {
      return { pending: fake.pending.length };
    },
  };
  return fake;
}

export const whats = (episodes: Array<{ what: string }>): Array<string> => episodes.map((ep) => ep.what);
