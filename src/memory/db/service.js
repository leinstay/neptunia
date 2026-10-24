// The memory database inside the bot (spec 2026-10-24-memory-store, sections 5, 7 and 10).
//
// `createMemoryDb({ hot, dataDir, log, now })` keeps `data/<memoryDb.file>` equal to the JSON memory files while the
// bot runs, lets the store read from it, and records what each turn's request carried:
//   - `features.memoryDb` (read at each tick) opens the database with the writer lock when it turns on and closes it
//     when it turns off. A refused open (a live holder of the lock, a broken file) is logged once per code and tried
//     again at the next tick; the bot never waits for it.
//   - a sync pass (sync.js#syncOnce) runs after each store flush (`requestSync`, deferred to the next loop turn) and at
//     least every `memoryDb.syncSeconds`, never two at once, never on the turn path. A pass that fails is logged with a
//     code only and tried again at the next tick; the JSON files stay the writer, so a failure costs nothing else.
//   - the first pass on an empty database is the full import. It runs in slices: the units (files, a month of vectors)
//     go to `syncOnce` a few at a time, the batch growing or shrinking to keep one slice near `sliceMs`, and the loop
//     is given back between slices. A file larger than the budget (one record day, one archive month) is one slice.
//   - `reader` is what the store reads through (store.js `memoryRead`): while `features.memoryDb` and `memoryDb.read`
//     are on and this process has synced once, a cache entry's first load takes the value from the database
//     (export.js#exportOne) and a directory's ids come from it. A file the database does not hold, holds behind the
//     disk, or does not map falls back to the disk read and is counted (`status().reads`).
//   - `recordTurnReads` writes the turn_reads rows of one step (`memoryDb.turnReads`), deferred, one transaction.
//   - `memoryWrite` is the one way her memory session and the description review write (session-write.js): a message to
//     the worker, so the bot's loop never holds a write transaction.
//   - `close()` waits for a pass under way, runs a last one (the caller has flushed the store), closes the database
//     and releases the lock. The waits are bounded by `memoryDb.closeTimeoutMs` (default 10000); then the worker is
//     terminated (a pass cut short is safe: every file is one transaction and the import takes up where it was).
//
// Threads. By default the writer connection, the lock, every sync pass and the turn_reads writes live in a worker
// thread (sync-worker.js); the main thread keeps a read-only connection, which is all the read switch and the status
// card need (WAL: readers never wait for the writer). turn_reads go to the worker as messages rather than being
// written from the main thread: a second writer would wait out the worker's write transaction (up to the busy
// timeout) on the bot's own loop. A worker that exits or crashes is logged with a code, its calls fail, and the next
// tick opens a new one (the dead one's lock is ours to take over). The main thread never runs a mapper. Injecting
// `sync` or `open` (the tests), or `worker: false`, keeps everything on the calling thread, with the sliced import.
// Counts and codes only in the logs, never a path, a name or a text.

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { lockPathOf, openMemoryDb } from './open.js';
import { syncOnce, walk, unitsOf } from './sync.js';
import { fillStems } from './stems.js';
import { exportOne, idsUnderDir } from './export.js';
import { channelPlaceId, guildPlaceId } from './ids.js';
import { memoryRootOf } from '../root.js';
import { applyDiaryUpdate, createDiaryMedia } from './diary-media.js';
import { applyMemoryWrite } from './session-write.js';

const DEFAULT_FILE = 'memory.db';
const DEFAULT_SYNC_SECONDS = 60;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const WORKER_FILE = new URL('./sync-worker.js', import.meta.url);
const IMPORT_DONE = 'service_import_done';
/** The weight of opening one unit in a slice, in bytes of file (about what a small file costs to import). */
const UNIT_WEIGHT = 20 * 1024;
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

/** The turn_reads rows (`{ row_kind, row_id }`) of one `memoryReads` list (prompt.js#buildRequest), resolved against the database. */
export function turnReadRows(db, reads, { guildId = null } = {}) {
  const rows = new Map();
  const put = (rowKind, rowId) => {
    if (typeof rowId === 'string' && rowId) rows.set(`${rowKind}\u0000${rowId}`, { row_kind: rowKind, row_id: rowId });
  };
  const hasRow = (table, id) => db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE id = ? LIMIT 1`).get(id) !== undefined;
  const latestMessage = db.prepare("SELECT id FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1");
  for (const read of Array.isArray(reads) ? reads : []) {
    const id = read?.id === undefined || read?.id === null ? '' : String(read.id);
    if (!id) continue;
    switch (read.kind) {
      case 'claim': put('claims', id); break;
      case 'episode': put('episodes', id); break;
      case 'participation': put('episodes', id); break;
      case 'recent_line': put('claims', id); break;
      case 'lore': put('claims', `lore:${id}`); break;
      case 'channel': put('places', channelPlaceId(id)); break;
      case 'guild_note': if (guildId) put('descriptions', `desc:${guildPlaceId(guildId)}:${id}`); break;
      case 'item':
        if (hasRow('claims', id)) put('claims', id);
        else if (hasRow('episodes', id)) put('episodes', id);
        break;
      case 'source': {
        const found = latestMessage.get(id);
        if (found) put('sources', found.id);
        break;
      }
      default: break;
    }
  }
  return [...rows.values()];
}

/** Waits for a promise (if any) for at most `ms`; a rejection of it is the caller's own business. */
async function waitFor(promise, ms) {
  if (!promise) return;
  let timer;
  try {
    await Promise.race([promise.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the sync worker. `call(type, payload)` posts one message and resolves with the worker's reply (a rejection
 * carries the worker's `code`); when the worker exits or fails, `dead` turns true, the calls under way reject with
 * `WORKER_EXIT` (or the error's code) and the exit is logged once, with a code and the exit code only.
 */
function startWorker({ workerFile, dataDir, log, codeOf }) {
  const worker = new Worker(workerFile, { workerData: { dataDir } });
  worker.unref();
  const pending = new Map();
  let seq = 0;
  let stopping = false;
  let logged = false;
  let exited = false;
  let onExit;
  const exit = new Promise((resolve) => { onExit = resolve; });
  const engine = { dead: false, call, stop };

  function fail(code) {
    engine.dead = true;
    for (const waiting of pending.values()) waiting.reject(Object.assign(new Error('memory db worker stopped'), { code }));
    pending.clear();
  }

  function call(type, payload = {}) {
    if (engine.dead) return Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' }));
    return new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      worker.postMessage({ ...payload, id: seq, type });
    });
  }

  worker.on('message', (message) => {
    if (message?.type === 'log') {
      log[message.level]?.(message.message, message.fields);
      return;
    }
    const waiting = pending.get(message?.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(Object.assign(new Error('memory db worker call failed'), { code: message.code }));
  });
  worker.on('error', (error) => {
    if (!logged && !stopping) { logged = true; log.warn('memory db: worker failed', { code: codeOf(error) }); }
    fail(codeOf(error));
  });
  worker.on('exit', (exitCode) => {
    exited = true;
    if (!logged && !stopping) { logged = true; log.warn('memory db: worker exited', { code: 'WORKER_EXIT', exit: exitCode }); }
    fail('WORKER_EXIT');
    onExit();
  });

  /** Asks the worker to close its database, waits up to `timeoutMs` for it to end, terminates it otherwise. */
  async function stop(timeoutMs, lockFile) {
    stopping = true;
    if (!engine.dead && timeoutMs > 0) {
      call('close').catch(() => {});
      await waitFor(exit, timeoutMs);
    }
    if (!exited) await worker.terminate();
    if (lockFile) {
      // A terminated or crashed worker cannot release the lock it took for this process.
      try {
        if (JSON.parse(fs.readFileSync(lockFile, 'utf8'))?.pid === process.pid) fs.rmSync(lockFile, { force: true });
      } catch { /* no lock, or not ours */ }
    }
  }

  return engine;
}

/**
 * @param {{ hot: { config: object }, dataDir: string, log?: object, now?: () => number,
 *   open?: typeof openMemoryDb, sync?: typeof syncOnce, defer?: (fn: () => void) => void, sliceMs?: number,
 *   clock?: () => number, diaryMediaDeps?: () => ({ port: object, imageFetcher: object }|null) }} options
 *   `diaryMediaDeps` (read at each tick) gives the interface port and the image fetcher the diary media job needs
 *   (`memoryDb.diaryMedia`, diary-media.js); without it the job does nothing.
 *   `defer` runs a function on the next turn of the event loop (setImmediate); `clock` is a monotonic
 *   millisecond clock for the slices (performance.now); both are injected by the tests.
 */
export function createMemoryDb({
  hot, dataDir, log = silent, now = Date.now, open, sync,
  defer = (fn) => setImmediate(fn), sliceMs = 30, clock = () => performance.now(),
  worker: useWorker, workerFile = WORKER_FILE, diaryMediaDeps = null, diarySleep,
}) {
  const threaded = useWorker ?? (open === undefined && sync === undefined);
  open ??= openMemoryDb;
  sync ??= syncOnce;
  const root = memoryRootOf(dataDir);
  let handle = null;
  let engine = null;
  let running = null;
  let dirty = true;
  let lastSyncAt = null;
  let lastPass = null;
  let importDone = false;
  let closing = false;
  const openErrors = new Set();
  const reads = { db: 0, missing: 0, stale: 0, unmapped: 0, empty: 0, errors: 0 };

  const on = () => hot.config?.features?.memoryDb === true;
  const settings = () => {
    const given = hot.config?.memoryDb ?? {};
    return {
      file: typeof given.file === 'string' && given.file ? given.file : DEFAULT_FILE,
      syncMs: (Number.isFinite(given.syncSeconds) && given.syncSeconds > 0 ? given.syncSeconds : DEFAULT_SYNC_SECONDS) * 1000,
      read: given.read === true,
      turnReads: given.turnReads !== false,
      closeMs: Number.isFinite(given.closeTimeoutMs) && given.closeTimeoutMs > 0 ? given.closeTimeoutMs : DEFAULT_CLOSE_TIMEOUT_MS,
    };
  };
  const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';
  const meta = (key) => handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => handle.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  async function openNow() {
    const { file } = settings();
    const dbPath = path.join(dataDir, file);
    let started = null;
    try {
      if (threaded) {
        started = startWorker({ workerFile, dataDir, log, codeOf });
        const opened = await started.call('open', { path: dbPath });
        handle = open(dbPath, { readOnly: true });
        engine = started;
        importDone = opened.importDone === true;
      } else {
        handle = open(dbPath);
        importDone = meta(IMPORT_DONE) === '1';
      }
      lastSyncAt = null;
      dirty = true;
      openErrors.clear();
      log.info('memory db: opened', { file });
    } catch (error) {
      handle = null;
      engine = null;
      if (started) await started.stop(0);
      const code = codeOf(error);
      if (!openErrors.has(code)) {
        openErrors.add(code);
        log.warn('memory db: open failed', { code });
      }
    }
  }

  /** Closes the database; the worker gets `timeoutMs` to finish what it holds, then it is terminated. */
  async function closeNow(timeoutMs = settings().closeMs) {
    if (!handle && !engine) return;
    if (handle) {
      try { handle.close(); } catch (error) { log.warn('memory db: close failed', { code: codeOf(error) }); }
    }
    const worker = engine;
    handle = null;
    engine = null;
    importDone = false;
    lastSyncAt = null;
    if (worker) await worker.stop(timeoutMs, lockPathOf(path.join(dataDir, settings().file)));
    log.info('memory db: closed', {});
  }

  // The sync's own per-pass line is info; here a pass is routine, so it goes to debug (the pass line below counts it).
  const passLog = { ...log, info: (...args) => log.debug?.(...args) };
  const yieldLoop = () => new Promise((resolve) => defer(resolve));

  /** The first pass: the units go to `syncOnce` in batches sized to `sliceMs`, the loop given back between them. */
  async function importSliced() {
    const total = { seen: 0, changed: 0, upserted: 0, retired: 0, errors: 0, slices: 0, maxSliceMs: 0 };
    const units = unitsOf(walk(dataDir), [], { count: 0 });
    // A slice is a run of units whose weights add up to `budget` (at least one unit, however large). A unit weighs its
    // bytes plus a fixed share for opening it; the budget follows the measured cost per weight so one slice stays near
    // `sliceMs`.
    const weightOf = (unit) => unit.size + UNIT_WEIGHT;
    let budget = 64 * 1024;
    for (let at = 0; at < units.length;) {
      // A shutdown does not wait for the import: it is idempotent and the next start takes it up again.
      if (!handle || closing) break;
      let end = at + 1;
      let weight = weightOf(units[at]);
      while (end < units.length && weight + weightOf(units[end]) <= budget) { weight += weightOf(units[end]); end += 1; }
      const group = units.slice(at, end);
      const allowed = new Set(group.flatMap((unit) => unit.parts.map((part) => part.rel)));
      const started = clock();
      const done = sync(handle, dataDir, { now, log: silent, filter: (rel) => allowed.has(rel) });
      const took = clock() - started;
      total.slices += 1;
      total.maxSliceMs = Math.max(total.maxSliceMs, took);
      for (const key of ['seen', 'changed', 'upserted', 'retired', 'errors']) total[key] += done[key] ?? 0;
      at += group.length;
      if (weight > 0 && took > 0) budget = Math.min(8 * 1024 * 1024, Math.max(16 * 1024, Math.round((weight / took) * sliceMs * 0.6)));
      else if (took <= 0) budget = Math.min(8 * 1024 * 1024, budget * 2);
      await yieldLoop();
    }
    if (handle && !closing && total.errors === 0) {
      // The slices left the stems (sync.js): stemmed once now, from all the text the import brought.
      try {
        fillStems(handle.db);
      } catch (error) {
        total.errors += 1;
        log.warn('memory db: stems failed', { code: codeOf(error) });
      }
    }
    if (handle && !closing && total.errors === 0) {
      setMeta(IMPORT_DONE, '1');
      importDone = true;
    }
    return total;
  }

  async function pass(reason) {
    const started = clock();
    const first = !importDone;
    dirty = false;
    try {
      let result;
      if (engine) {
        result = await engine.call('pass', { first, now: now() });
        if (result.importDone) importDone = true;
      } else {
        result = first ? await importSliced() : sync(handle, dataDir, { now, log: passLog });
      }
      lastSyncAt = now();
      lastPass = { at: lastSyncAt, first, ms: Math.round(clock() - started), errors: result.errors, changed: result.changed, ...(first ? { slices: result.slices, maxSliceMs: Math.round(result.maxSliceMs * 10) / 10 } : {}) };
      if (result.errors > 0) dirty = true;
      log.debug?.('memory db: pass', { reason, first, seen: result.seen, changed: result.changed, upserted: result.upserted, retired: result.retired, errors: result.errors, ms: lastPass.ms, ...(first ? { slices: result.slices, maxSliceMs: lastPass.maxSliceMs } : {}) });
    } catch (error) {
      dirty = true;
      lastPass = { at: now(), first, failed: true };
      if (!closing) log.warn('memory db: pass failed', { reason, code: codeOf(error) });
    }
  }

  function runPass(reason) {
    if (running) return running;
    running = pass(reason).finally(() => { running = null; });
    return running;
  }

  // The diary's text and pictures (diary-media.js): off by default, one run per start over the rows still without text.
  const diaryJob = createDiaryMedia({
    db: () => (handle ? handle.db : null),
    apply: (update) => (engine ? engine.call('diaryApply', { update }) : applyDiaryUpdate(handle, update)),
    port: () => diaryMediaDeps?.()?.port ?? null,
    imageFetcher: () => diaryMediaDeps?.()?.imageFetcher ?? null,
    config: () => hot.config,
    dataDir,
    log,
    sleep: diarySleep,
  });
  function startDiaryMedia() {
    if (closing || !on() || !handle || !importDone || lastSyncAt === null || running) return;
    if (hot.config?.memoryDb?.diaryMedia !== true || engine?.dead) return;
    if (!diaryJob.hasWork()) return;
    diaryJob.run().catch((error) => log.warn('diary media: run failed', { code: codeOf(error) }));
  }

  /** The tick: follows the switch, runs a pass when one is due. Safe to call at any rate. */
  async function tick() {
    if (closing) return;
    if (!on()) {
      if (handle || engine) {
        await waitFor(running, settings().closeMs);
        await closeNow();
      }
      return;
    }
    if (engine?.dead && !running) await closeNow(0);
    if (!handle) {
      // On the calling thread the open is synchronous; only the worker's open is waited for.
      const opening = openNow();
      if (threaded) await opening;
    }
    if (!handle || running) return;
    if (dirty || lastSyncAt === null || now() - lastSyncAt >= settings().syncMs) await runPass('tick');
    startDiaryMedia();
  }

  /** A flush wrote files: a pass soon, off the caller's path. */
  function requestSync() {
    dirty = true;
    if (!on() || closing) return;
    defer(() => { tick().catch((error) => log.warn('memory db: tick failed', { code: codeOf(error) })); });
  }

  const readActive = () => on() && settings().read && handle !== null && importDone && lastSyncAt !== null;
  const count = (key) => { reads[key] += 1; return null; };

  /**
   * The database for recall (src/memory/db/recall.js, `recall.backend` `db`): the read-only connection while the
   * switch is on, this process has synced once and the first import is done; else null (recall then reads as it did).
   */
  const database = () => (on() && handle !== null && importDone && lastSyncAt !== null ? handle.db : null);

  /** What the store reads through (store.js `memoryRead`). */
  const reader = {
    value(file) {
      if (!readActive()) return null;
      try {
        const found = exportOne(handle, root.relative(file), { dataDir });
        if (found.found) { reads.db += 1; return found; }
        return count(found.reason in reads ? found.reason : 'missing');
      } catch (error) {
        reads.errors += 1;
        log.warn('memory db: read failed', { code: codeOf(error) });
        return null;
      }
    },
    ids(dir) {
      if (!readActive()) return null;
      try {
        return idsUnderDir(handle, root.relative(dir));
      } catch (error) {
        reads.errors += 1;
        log.warn('memory db: read failed', { code: codeOf(error) });
        return null;
      }
    },
  };

  /**
   * The memory a turn's request carried (prompt.js `memoryReads`), written as turn_reads rows of its step, deferred.
   * @param {{ turnId: string, step?: string, guildId?: string|null, reads: { kind: string, id: string }[] }} args
   */
  function recordTurnReads({ turnId, step = 's0', guildId = null, reads: carried }) {
    if (!handle || !on() || !settings().turnReads || !turnId || !Array.isArray(carried) || carried.length === 0) return;
    if (engine) {
      defer(() => {
        if (!engine || engine.dead) return;
        engine.call('turnReads', { turnId: String(turnId), step: String(step), guildId, reads: carried })
          .then((done) => { if (done.rows > 0) log.debug?.('memory db: turn reads', { rows: done.rows }); })
          .catch((error) => log.warn('memory db: turn reads failed', { code: codeOf(error) }));
      });
      return;
    }
    defer(() => {
      if (!handle) return;
      try {
        const rows = turnReadRows(handle.db, carried, { guildId });
        if (rows.length === 0) return;
        handle.transaction(() => {
          const insert = handle.db.prepare('INSERT OR IGNORE INTO turn_reads (turn_id, step, row_kind, row_id) VALUES (?, ?, ?, ?)');
          for (const row of rows) insert.run(String(turnId), String(step), row.row_kind, row.row_id);
        });
        log.debug?.('memory db: turn reads', { rows: rows.length });
      } catch (error) {
        log.warn('memory db: turn reads failed', { code: codeOf(error) });
      }
    });
  }

  /**
   * One write of her memory session or a description review (session-write.js), on the writer connection: a message
   * to the worker, or the calling thread's own connection when there is no worker. Rejects when the database is closed.
   */
  async function memoryWrite(update) {
    if (!handle || !on() || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    if (engine) return engine.call('memoryWrite', { update });
    return applyMemoryWrite(handle, update);
  }

  /** The state for the status card: on/off, rows, the last pass, how far behind it is, the read switch. */
  function status() {
    const open = handle !== null;
    let rows = null;
    let files = null;
    if (open) {
      try {
        files = handle.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
        rows = 0;
        for (const table of ['sources', 'claims', 'episodes', 'descriptions', 'places', 'people', 'day', 'diary']) {
          rows += handle.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NULL`).get().n;
        }
      } catch { /* a closing database */ }
    }
    return {
      on: on(),
      open,
      files,
      rows,
      importDone,
      lastSyncAt,
      lagSeconds: open && lastSyncAt !== null ? Math.max(0, Math.round((now() - lastSyncAt) / 1000)) : null,
      read: on() && settings().read,
      readActive: readActive(),
      lastPass,
      reads: { ...reads },
    };
  }

  /** Shutdown: waits for a pass under way, runs a last one (the store is flushed), closes the database, releases the lock. */
  async function close() {
    closing = true;
    const { closeMs } = settings();
    const deadline = performance.now() + closeMs;
    await waitFor(diaryJob.stop(), closeMs);
    await waitFor(running, closeMs);
    if (handle && on() && importDone && !running && !engine?.dead) {
      try { await waitFor(runPass('shutdown'), Math.max(0, deadline - performance.now())); } catch { /* logged inside */ }
    }
    await closeNow(Math.max(0, deadline - performance.now()));
  }

  return { tick, requestSync, reader, database, recordTurnReads, memoryWrite, status, close };
}
