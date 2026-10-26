// A memory database for a test: the real service (src/memory/db/service.js) over a temporary data directory, on the
// calling thread (no worker), opened by its first tick, every job off unless the test's config turns it on. The
// memory modules a test builds take it as their `memoryDb`, as src/index.js wires them. `seed` (optional) fills it
// from the data directory first (seed.js: the memory units a fixture wrote there). `openTestMemorySync` is the same
// service opened at once (on the calling thread the first tick opens the database synchronously), for a test that
// builds its stores synchronously; `unitFile` is a memory unit as the file it stands for (its text, from the database
// alone). Synthetic data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../../../src/memory/db/service.js';
import { openMemoryDb } from '../../../src/memory/db/open.js';
import { classify } from '../../../src/memory/db/map/index.js';
import { filesOfUnit } from '../../../src/memory/db/export.js';
import { seedUnits } from './seed.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** @type {Set<string>} */
const made = new Set();
let sweepArmed = false;

/** Removes every directory `tempDataDir` made in this process. A test file runs in its own process, so its folders go when it ends. */
function sweep() {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  made.clear();
}

/** A temporary data directory under TMPDIR, removed when the test process exits (tests reopen one after a close, so `close()` leaves it). */
export function tempDataDir(prefix = 'memdb-test-') {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  made.add(dir);
  if (!sweepArmed) {
    sweepArmed = true;
    process.once('exit', sweep);
  }
  return dir;
}

/**
 * The opened service over `dataDir` (a new temporary one when omitted): `{ memoryDb, dataDir, close() }`. `config` is
 * laid over the defaults (every job off); `seed` writes the data directory's memory units into the database before it
 * opens; `now` is the service's clock.
 * @param {{ dataDir?: string, config?: object, seed?: boolean, now?: () => number, log?: object }} [options]
 */
export async function openTestMemory({ dataDir = tempDataDir(), config = {}, seed = false, now = Date.now, log = silent } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (seed) {
    const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
    try {
      seedUnits(handle, dataDir);
    } finally {
      handle.close();
    }
  }
  const hot = { config: { ...config, memoryDb: { session: { mode: 'off' }, ...(config.memoryDb ?? {}) } }, prompts: {} };
  const memoryDb = createMemoryDb({ hot, dataDir, log, now, worker: false });
  await memoryDb.tick();
  if (!memoryDb.readHandle()) throw new Error('the test memory database did not open');
  return { memoryDb, dataDir, hot, close: () => memoryDb.close() };
}

/**
 * The opened service over `dataDir` (a new temporary one when omitted), open when this returns: `{ memoryDb, dataDir,
 * close() }`. The unit writes it takes land a microtask later (the outbox of a module sends them then).
 * @param {{ dataDir?: string, config?: object, now?: () => number, log?: object }} [options]
 */
export function openTestMemorySync({ dataDir = tempDataDir(), config = {}, now = Date.now, log = silent } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const hot = { config: { ...config, memoryDb: { session: { mode: 'off' }, ...(config.memoryDb ?? {}) } }, prompts: {} };
  const memoryDb = createMemoryDb({ hot, dataDir, log, now, worker: false });
  memoryDb.tick();
  if (!memoryDb.readHandle()) throw new Error('the test memory database did not open');
  return { memoryDb, dataDir, hot, close: () => memoryDb.close() };
}

/**
 * The memory unit `rel` (its path under data/: `guilds/<id>/tasks.json`, `guilds/<id>/tasks.jsonl`) as the text of
 * the file it stands for, built from the database alone; null when the database holds none.
 * @param {{ readHandle: () => { db: object } | null }} memoryDb
 * @param {string} rel
 */
export function unitFile(memoryDb, rel) {
  const db = memoryDb.readHandle().db;
  const info = classify(rel);
  if (!info || info.skipped) return null;
  const full = info.guildId === undefined ? info.unit : `guilds/${info.guildId}/${info.unit}`;
  if (!db.prepare('SELECT 1 AS ok FROM files WHERE path = ? AND gone_at IS NULL').get(full)) return null;
  const [out] = filesOfUnit(db, info.unit, info, full);
  return out ? out.data.toString('utf8') : null;
}
