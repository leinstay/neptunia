// The helpers of the store tests: a memory database over a temporary data directory, the unit files it holds, an archive stand-in and the writers' lines of a channel.
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './tmp.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { unitValue } from '../../src/memory/db/readers/common.ts';
import { asRecord } from './records.ts';
import type { Untyped } from '../../src/tools/types.ts';

export function tmpDataDir() {
  return tempDir('nep-store-');
}

export const SILENT = { info() {}, debug() {}, warn() {}, error() {} };
/** The memory databases opened here, by data directory; closed once the file is done. */
export const MEMORY_OF = new Map();
after(async () => {
  for (const memoryDb of MEMORY_OF.values()) await memoryDb.close();
});

/**
 * A temporary data directory with its memory database open on the calling thread (the first tick opens it at once):
 * `{ dir, memoryDb }`, the `memoryDb` the store takes.
 */
export function memDataDir() {
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

/** One turn of the event loop: the unit writes a flush handed to the database have run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The value the database holds for the memory unit `rel` (its path under data/), or undefined. */
export function unitOf(memoryDb: Untyped, rel: string) {
  return asRecord(unitValue(memoryDb.readHandle().db, rel))?.value;
}

/** The value of the unit `rel` as JSON text (a byte check of "nothing was written"). */
export function unitText(memoryDb: unknown, rel: string) {
  return JSON.stringify(unitOf(memoryDb, rel));
}

/** Writes `value` as the memory unit `rel`, as a hand edit or an older engine left it. */
export function putUnit(memoryDb: Untyped, rel: string, value: unknown) {
  return memoryDb.writeUnit({ op: 'value', owner: rel, value });
}

export const WRITERS_DAY_MS = 24 * 60 * 60 * 1000;
export const WRITERS_T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
export const AGORA_FACTS = { name: 'αγορά', category: null, topic: null };

/** `count` messages of one writer in a channel, a millisecond apart from `fromTs`; the channel after the last. */
export function writeLines(
  store: Untyped,
  channelId: string,
  authorId: string,
  count: number,
  fromTs: number,
  opts?: unknown
) {
  let channel;
  for (let n = 0; n < count; n += 1)
    channel = store.touchChannel('g1', channelId, AGORA_FACTS, fromTs + n, authorId, opts);
  return channel;
}

/** A channel file as the store wrote it before the tally existed. */
export function writeOldChannelFile(dir: string, channelId: string, fields = {}) {
  const file = path.join(dir, 'guilds', 'g1', 'channels', `${channelId}.json`);
  const old = {
    id: channelId,
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
export function memoryFileOf(file: string) {
  for (const [dir, memoryDb] of MEMORY_OF) {
    if (file.startsWith(dir + path.sep)) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      if (
        !/^(?:state|usage|metrics)\.json$/.test(rel) &&
        !/\/(?:participation|gifs|media|inner|missed)\.json$/.test(rel)
      )
        return [dir, memoryDb, rel];
    }
  }
  return null;
}

/** `file` as text: a memory unit as its value's JSON, any other file from the disk. */
export function readRaw(file: string) {
  const found = memoryFileOf(file);
  return found ? unitText(found[1], found[2]) : fs.readFileSync(file, 'utf8');
}

/** Whether `file` is there: a memory unit in the database, any other file on the disk. */
export function existsRaw(file: string) {
  const found = memoryFileOf(file);
  return found ? unitOf(found[1], found[2]) !== undefined : fs.existsSync(file);
}

/** `value` as `file`: a memory unit of a data directory with a database goes into it, any other file to the disk. */
export function writeRaw(file: string, value: unknown) {
  const found = memoryFileOf(file);
  if (found) return putUnit(found[1], found[2], value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value)); // compact: a flush would rewrite it pretty-printed
  return null;
}

/** An archive stand-in: what was appended or queued; with `manual`, `append` resolves when released. */
export function fakeArchive({ manual = false, fail = false } = {}) {
  const fake = {
    appended: [] as Array<Untyped>,
    pending: [] as Array<Untyped>,
    events: [] as Array<string>,
    fail,
    releases: [] as Array<() => void>,
    append(guildId: string, entries: Untyped, opts = {}) {
      fake.appended.push({ guildId, entries, opts });
      if (fake.fail) return Promise.reject(Object.assign(new Error('disk refused'), { code: 'archive-unconfirmed' }));
      const result = { written: entries.length, duplicates: 0 };
      if (!manual) return Promise.resolve(result);
      return new Promise((resolve) => {
        fake.releases.push(() => {
          fake.events.push('append-resolved');
          resolve(result);
        });
      });
    },
    async queuePending(guildId: string, entries: Untyped, opts = {}) {
      fake.pending.push(...entries.map((entry: Untyped) => ({ guildId, entry, opts })));
      return entries.length;
    },
    async drainPending() {
      const confirmed = fake.pending.splice(0).map((item) => asRecord(item).entry);
      return { archived: confirmed.length, left: 0, confirmed };
    },
    stats() {
      return { pending: fake.pending.length };
    },
  };
  return fake;
}

export const whats = (episodes: Untyped) => episodes.map((ep: Untyped) => ep.what);
