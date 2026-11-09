// A memory database for a test: the real service (src/memory/db/service.ts) over a temporary data directory, on the
// calling thread (no worker), opened by its first tick, every job off unless the test's config turns it on. The
// memory modules a test builds take it as their `memoryDb`, as src/index.ts wires them. `seed` (optional) fills it
// from the data directory first (seed.ts: the memory units a fixture wrote there). `openTestMemorySync` is the same
// service opened at once (on the calling thread the first tick opens the database synchronously), for a test that
// builds its stores synchronously; `unitFile` is a memory unit as the file it stands for (its text, from the database
// alone). Synthetic data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbOf, type Config, type Log } from '../../../src/memory/db/types.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { classify } from '../../../src/memory/migration/classify.ts';
import { filesOfUnit } from '../../../src/memory/db/export.ts';
import { seedUnits } from './seed.ts';
import { legacyStorageKey } from '../../../src/memory/migration/paths.ts';
import { listUnits } from '../../../src/memory/db/storage-units.ts';
import { isOperationalKind } from '../../../src/memory/db/operational.ts';
import { unitValue, unitLines } from '../../../src/memory/db/readers/common.ts';
import type { StorageKey } from '../../../src/memory/db/storage-keys.ts';
import { placeOrPersona } from '../../../src/memory/db/storage-keys.ts';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

const made = new Set<string>();
let sweepArmed = false;

/** Removes every directory `tempDataDir` made in this process. A test file runs in its own process, so its folders go when it ends. */
function sweep(): void {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  made.clear();
}

/** A temporary data directory under TMPDIR, removed when the test process exits (tests reopen one after a close, so `close()` leaves it). */
export function tempDataDir(prefix = 'memdb-test-'): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  made.add(dir);
  if (!sweepArmed) {
    sweepArmed = true;
    process.once('exit', sweep);
  }
  return dir;
}

/** An opened test service: the service, its data directory, the live config it was given and the way to close it. */
export type TestMemory = {
  memoryDb: MemoryDbService;
  dataDir: string;
  hot: { config: Config; prompts: Record<string, never> };
  close: () => Promise<void>;
};

/**
 * The opened service over `dataDir` (a new temporary one when omitted): `{ memoryDb, dataDir, close() }`. `config` is
 * laid over the defaults (every job off); `seed` writes the data directory's memory units into the database before it
 * opens; `now` is the service's clock.
 */
export async function openTestMemory({
  dataDir = tempDataDir(),
  config = {},
  seed = false,
  now = Date.now,
  log = silent,
  iface,
}: {
  dataDir?: string;
  config?: Config;
  seed?: boolean;
  now?: () => number;
  log?: Partial<Log>;
  iface?: () => string | null;
} = {}): Promise<TestMemory> {
  fs.mkdirSync(dataDir, { recursive: true });
  if (seed) {
    const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
    try {
      seedUnits(handle, dataDir);
    } finally {
      handle.close();
    }
  }
  const hot = {
    config: { ...config, memoryDb: { session: { mode: 'off' }, ...(config.memoryDb ?? {}) } },
    prompts: {},
  };
  // The service calls only the methods of `log` a test gives it.
  const memoryDb = createMemoryDb({ hot, dataDir, log: log as Log, now, worker: false, iface });
  await memoryDb.tick();
  if (!memoryDb.readHandle()) throw new Error('the test memory database did not open');
  return { memoryDb, dataDir, hot, close: () => memoryDb.close() };
}

/**
 * The opened service over `dataDir` (a new temporary one when omitted), open when this returns: `{ memoryDb, dataDir,
 * close() }`. The unit writes it takes land a microtask later (the outbox of a module sends them then).
 */
export function openTestMemorySync({
  dataDir = tempDataDir(),
  config = {},
  now = Date.now,
  log = silent,
}: { dataDir?: string; config?: Config; now?: () => number; log?: Partial<Log> } = {}): TestMemory {
  fs.mkdirSync(dataDir, { recursive: true });
  const hot = {
    config: { ...config, memoryDb: { session: { mode: 'off' }, ...(config.memoryDb ?? {}) } },
    prompts: {},
  };
  const memoryDb = createMemoryDb({ hot, dataDir, log: log as Log, now, worker: false });
  memoryDb.tick();
  if (!memoryDb.readHandle()) throw new Error('the test memory database did not open');
  return { memoryDb, dataDir, hot, close: () => memoryDb.close() };
}

/**
 * The memory unit `rel` (its path under data/: `guilds/<id>/errands.json`, `guilds/<id>/errands.jsonl`) as the text of
 * the file it stands for, built from the database alone; null when the database holds none.
 */
export function unitFile(memoryDb: Pick<MemoryDbService, 'readHandle'>, rel: string): string | null {
  const handle = memoryDb.readHandle();
  if (!handle) throw new Error('the memory database is not open');
  const db = dbOf(handle);
  const info = classify(rel);
  if (!info || 'skipped' in info) return null;
  const full = info.guildId === undefined ? info.unit : `guilds/${info.guildId}/${info.unit}`;
  // This fixture accepts a legacy export label. Fresh semantic units need no provenance alias.
  const key = legacyStorageKey(full);
  // A kind with rows of its own (an operational kind, the intentions) has no unit: its rows are the answer.
  const direct = key.kind === 'intentions' || isOperationalKind(key.kind);
  if (!direct && listUnits(db, key).length === 0) return null;
  if (info.format === 'jsonl') {
    const lines = unitLines(db, key);
    if (direct && lines.length === 0) return null;
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
  if (info.format === 'json') {
    const value = unitValue(db, key);
    return value.found ? `${JSON.stringify(value.value, null, 2)}\n` : null;
  }
  const [out] = filesOfUnit(db, info.unit, info, full);
  return out ? out.data.toString('utf8') : null;
}

/** A journal's test label projected from its actual key, with no change to the writer update. */
export function journalLabel(dataDir: string, key: StorageKey): string {
  return path.join(dataDir, 'places', key.subject.id, 'journal', `${key.partition}.jsonl`);
}

/** The label of a journal line a write kind `journal-lines` write carries: its place's day, as `journalLabel` names it. */
export function journalLineLabel(dataDir: string, placeId: string | null, line: { occurredAt?: unknown }): string {
  return journalLabel(dataDir, placeOrPersona('journal', placeId, { partition: String(line.occurredAt).slice(0, 10) }));
}
