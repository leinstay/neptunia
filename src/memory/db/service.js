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
//   - `recordTurnReads` resolves the memory rows one step's request carried when it is called, at assembly time, on the
//     read connection (the block each was in, its order, the exact claim / description version and source revision),
//     and writes the turn_reads rows deferred, one transaction (`memoryDb.turnReads`). The persistence is deferred; the
//     resolution is not, so a later sync cannot change which version a turn is said to have read.
//   - `memoryWrite` is the one way her memory session and the description review write (session-write.js): a message to
//     the worker, so the bot's loop never holds a write transaction. The service stamps its authority (fixed for the
//     process) and `memoryDb.audienceColumn` (the read predicate of the target check) into every write; `apply` is
//     refused unless authority is `db`.
//   - `issueContext(spec)` issues an execution context (scope.js#issueContext: an id, the mode, the destination) read
//     through the triple or `audience_id` as `memoryDb.audienceColumn` says, and records it in `execution_contexts`
//     (deferred, through the writer) while the database is open; closed, the context is a pure object all the same.
//     `recordTurnReads` stores the context id (`contextId`, '' without one) and the reader kind (`turn` by default).
//   - `memoryDb.authority` (`json` by default, `db`) says who writes the memory. While `json`, the JSON-to-database sync
//     runs as above. While `db`, the sync is off (no tick pass, no `requestSync`, no shutdown pass), the database is
//     taken as in step from the moment it is opened, and the status says so (`authority`, `syncOff`). The read switch
//     (`memoryDb.read`) never changes who writes.
//   - the focus job (schema v10, focus.js; `memoryDb.focus.enabled`, off by default): once per UTC day, at a tick, the
//     relationship counts of yesterday and today are recounted and the close and exploring sets recomputed, through the
//     writer (the worker), with the live `focus` settings. `focusPeople()` reads the sets for the heartbeat's people
//     view on the read connection (an internal reader), with `focus.exploringShare`; null while the database is closed.
//   - schema v11 (wakes.js, skills.js, index-policy.js), every part behind its own switch, all off by default:
//       `memoryDb.wakeRuns`: `recordWake(update)` is the inner life's one way to write its wake runs (src/behavior/
//       inner.js), through the writer; at each open the runs a dead process left `running` longer than the inner
//       turn's time budget (`innerLife.loop.timeBudgetMs`) become `interrupted`.
//       `memoryDb.skillsRegistry`: at each open every skill of src/skills/definitions.js is registered with its
//       content hash (its definition and its operation's source file under src/ops/), its manifest and the engine
//       commit (`git rev-parse HEAD`, else `unknown`; `commit` injects it).
//       `recall.db.vectorEviction`: once per UTC day, at a tick, the index policy classifies every line and evicts
//       the vectors outside the owner's classes, through the writer; the sources a turn's request carried
//       (`recordTurnReads`) and a memory session's batch read (`memoryWrite`) are touched, so their vectors come back.
//       `recall.db.reembed` (with an injected `embed`, the embedding client): at most once a minute, at a tick, the
//       touched lines' evicted vectors are embedded again (index-policy.js#reembedTouched) on this thread, and written
//       through the writer.
//   - `observe(envelope)` (stage 8a, `memoryDb.observeLive`, off by default): one observation of the live message path
//     (observe.js#observe, the envelope from observe-event.js#observationOf) through the writer, like every other
//     write; while the JSON files are the writer it lands on the rows the sync writes (observe.js resolves them, the
//     sync adopts the ones it wrote first). Null while the switch is off or the database closed; never throws.
//   - `authority()` is who writes and reads the memory (stages W1 and W2a, spec 2026-10-24-memory-authority section 6
//     item 1): `memoryDb.authority` as it was when the service was created, fixed for the process. A later change of
//     the config is logged once per value (`memory db: authority change needs a restart`) and changes nothing: the
//     sync, the status, the write stamping and the modules (record, archive, journal, vectors, the intention and task
//     stores, the store's directory ids, the embedder's catch-up) all follow the fixed value, never the config.
//     `readHandle()` is the read-only connection while the database is open (null otherwise): what their database
//     readers read through (src/memory/db/readers/).
//   - start checks (authority.js#authorityRefusal): under `db` the database is not opened (the memory does not start)
//     unless `memoryDb.read` is exactly true, `recall.backend` is `db` and `memoryDb.observeLive` is exactly true; the
//     sync is off under `db` by construction. A refusal is logged once per code (`memory db: start refused`), the
//     status says it (`refused`), and every tick checks the live config again.
//   - `writeUnit(update)` (stage W2a, unit-write.js): the database writers of the append-like units (record and
//     journal lines, participation, the diary, the vectors) through the writer, stamped with the fixed authority;
//     resolves once the worker committed, rejects with a code (`DB_CLOSED` while the database is not open). Under `db`
//     each tick also finishes the graph projection and the stems a sync pass would have finished (one slice a tick).
//     The opener's migration context is the live `diary.channelId`'s place (schema v12's data step).
//   - stage W2b, under `db`: `writeUnit` op `value` takes every JSON unit of the store's cache and of the module
//     stores, op `lines` the archive months and the module stores' JSONL units (unit-write.js); `reader.value` answers
//     from the database alone (no disk check, a closed database throws `DB_CLOSED`). The durable intent of a write
//     that failed (spec section 6 item 3): `keepPending(update)` (at shutdown, from unit-outbox.js#keep) writes it to
//     `data/memory-pending/<sha1 of the owner>.json` (`{ owner, op, value | lines, at }`; the lines of one owner are
//     appended to what its file holds), and every open under `db` replays each pending file through the writer before
//     anything reads the database (`readHandle()` and `reader` answer nothing meanwhile), deleting a file only after
//     its write resolved. A replay that fails keeps its file, logs `memory db: pending replay failed` (an error, with
//     the count) and fails the open (`PENDING_REPLAY`): the database is not used behind a write it has not taken.
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
import { contextRow, issueContext as issuePureContext } from './scope.js';
import { memoryRootOf } from '../root.js';
import { applyDiaryUpdate, createDiaryMedia } from './diary-media.js';
import { NEWEST_CLAIM_VERSION_SQL, applyMemoryWrite, writeTurnReadRows } from './session-write.js';
import { projectPending } from './graph.js';
import { focusView, lastFocusDay, runFocusDay } from './focus.js';
import { utcDay } from '../../time.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skillVersionsOf } from './skills.js';
import { indexSettings, reembedTouched } from './index-policy.js';
import { observe as observeEnvelope } from './observe.js';
import { authorityRefusal } from './authority.js';
import { graphPending } from './graph.js';
import { stemsPending } from './stems.js';
import { createHash } from 'node:crypto';

/** The folder of the unit writes that failed at a shutdown (stage W2b), under the data directory. */
export const PENDING_DIR = 'memory-pending';

const DEFAULT_FILE = 'memory.db';
const DEFAULT_SYNC_SECONDS = 60;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
/** The inner turn's time budget when `innerLife.loop.timeBudgetMs` is not set (config.json's value). */
const DEFAULT_TURN_BUDGET_MS = 180_000;
/** The least time between two runs of the re-embed job. */
const REEMBED_EVERY_MS = 60_000;
const OPS_DIR = new URL('../../ops/', import.meta.url);
const ENGINE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The source text of each operation's module under src/ops/ (op name -> the file's text). */
export function opSources(dir = OPS_DIR) {
  const out = new Map();
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.js')).sort()) {
    const text = fs.readFileSync(new URL(name, dir), 'utf8');
    for (const match of text.matchAll(/defineOp\(\{\s*name:\s*'([^']+)'/g)) out.set(match[1], text);
  }
  return out;
}

/** The engine's commit (`git rev-parse HEAD` in the checkout), or 'unknown'. */
export function engineCommit(cwd = ENGINE_ROOT) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}
const WORKER_FILE = new URL('./sync-worker.js', import.meta.url);
const IMPORT_DONE = 'service_import_done';
/** The weight of opening one unit in a slice, in bytes of file (about what a small file costs to import). */
const UNIT_WEIGHT = 20 * 1024;
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

/**
 * The turn_reads rows of one `memoryReads` list (prompt.js#buildRequest), resolved against the database now:
 * `{ row_kind, row_id, block, ord, version_id, revision }`. `block` and `ord` are the block the read sat in and its place
 * in the request; `version_id` is the newest claim version or the current description version; `revision` a source's.
 * Besides the kinds her turns name, a read may name a row by its database id (her memory session's request does):
 * `source_id`, `description`, `place`, `intention`.
 */
export function turnReadRows(db, reads, { guildId = null, authority = 'discord/global' } = {}) {
  const rows = new Map();
  const claimVersion = db.prepare(NEWEST_CLAIM_VERSION_SQL);
  const descriptionVersion = db.prepare('SELECT current_version AS id FROM descriptions WHERE id = ?');
  const sourceRevision = db.prepare('SELECT revision FROM sources WHERE id = ?');
  let at = 0;
  const put = (rowKind, rowId, read) => {
    if (typeof rowId !== 'string' || !rowId) return;
    const key = `${rowKind}\u0000${rowId}`;
    if (rows.has(key)) return;
    let versionId = null;
    let revision = null;
    if (rowKind === 'claims') versionId = claimVersion.get(rowId)?.id ?? null;
    else if (rowKind === 'descriptions') versionId = descriptionVersion.get(rowId)?.id ?? null;
    else if (rowKind === 'sources') revision = sourceRevision.get(rowId)?.revision ?? null;
    rows.set(key, { row_kind: rowKind, row_id: rowId, block: typeof read.block === 'string' ? read.block : null, ord: Number.isInteger(read.ord) ? read.ord : at, version_id: versionId, revision });
  };
  const hasRow = (table, id) => db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE id = ? LIMIT 1`).get(id) !== undefined;
  // A message id is native to one authority: the turn's (Discord's global snowflakes today), never matched alone.
  const latestMessage = db.prepare("SELECT id FROM sources WHERE native_id = ? AND authority_id IS ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1");
  for (const read of Array.isArray(reads) ? reads : []) {
    at += 1;
    const id = read?.id === undefined || read?.id === null ? '' : String(read.id);
    if (!id) continue;
    switch (read.kind) {
      case 'claim': put('claims', id, read); break;
      case 'episode': put('episodes', id, read); break;
      case 'participation': put('episodes', id, read); break;
      case 'recent_line': put('claims', id, read); break;
      case 'lore': put('claims', `lore:${id}`, read); break;
      case 'channel': put('places', channelPlaceId(id), read); break;
      case 'guild_note': if (guildId) put('descriptions', `desc:${guildPlaceId(guildId)}:${id}`, read); break;
      case 'item':
        if (hasRow('claims', id)) put('claims', id, read);
        else if (hasRow('episodes', id)) put('episodes', id, read);
        break;
      case 'source': {
        const found = latestMessage.get(id, authority);
        if (found) put('sources', found.id, read);
        break;
      }
      case 'source_id': put('sources', id, read); break;
      case 'description': put('descriptions', id, read); break;
      case 'place': put('places', id, read); break;
      case 'intention': put('intentions', id, read); break;
      default: break;
    }
  }
  return [...rows.values()];
}

/** The reader kinds of `turn_reads`. */
export const READER_KINDS = Object.freeze(['turn', 'session', 'wake']);

/**
 * Writes resolved turn_reads rows (`turnReadRows`) of one step in one transaction. A row's `context_id` is the
 * execution context it was read in ('' when none was issued) and `reader_kind` who read it (`turn` by default).
 */
export function insertTurnReads(handle, turnId, step, rows) {
  handle.transaction(() => writeTurnReadRows(handle.db, turnId, step, rows));
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
 *   `embed` is the embedding client's `embed(texts, { config, purpose })` (the re-embed job; none: the job does
 *   nothing), `commit` the engine commit for the skills registry (default `git rev-parse HEAD`), `selfName()` her name
 *   in a rebuilt embedding input.
 */
export function createMemoryDb({
  hot, dataDir, log = silent, now = Date.now, open, sync,
  defer = (fn) => setImmediate(fn), sliceMs = 30, clock = () => performance.now(),
  worker: useWorker, workerFile = WORKER_FILE, diaryMediaDeps = null, diarySleep,
  embed = null, commit = null, selfName = () => '',
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
  const pendingReads = new Set();
  const writingReads = new Set();
  let importDone = false;
  let closing = false;
  let closed = false;
  const openErrors = new Set();
  const reads = { db: 0, missing: 0, stale: 0, unmapped: 0, empty: 0, errors: 0 };
  // Who the readers read, fixed for the process (see `authority()`), and the changes already logged.
  const pinnedAuthority = hot.config?.memoryDb?.authority === 'db' ? 'db' : 'json';
  const authorityChanges = new Set();

  const on = () => hot.config?.features?.memoryDb === true;
  const settings = () => {
    const given = hot.config?.memoryDb ?? {};
    return {
      file: typeof given.file === 'string' && given.file ? given.file : DEFAULT_FILE,
      syncMs: (Number.isFinite(given.syncSeconds) && given.syncSeconds > 0 ? given.syncSeconds : DEFAULT_SYNC_SECONDS) * 1000,
      read: given.read === true,
      // Fixed for the process (see `authority()`): every consumer below reads this, never the live value.
      authority: pinnedAuthority,
      turnReads: given.turnReads !== false,
      closeMs: Number.isFinite(given.closeTimeoutMs) && given.closeTimeoutMs > 0 ? given.closeTimeoutMs : DEFAULT_CLOSE_TIMEOUT_MS,
    };
  };
  const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';
  const meta = (key) => handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => handle.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  // Under `db`, while the pending unit writes of the last shutdown are replayed at an open, nothing reads the database.
  let replaying = false;
  const pendingDir = path.join(dataDir, PENDING_DIR);

  // Why the memory may not start under the fixed authority (authority.js), as of the last open attempt; null when it may.
  let refused = null;
  const refusedLogged = new Set();
  /** The start check of the live config under the fixed authority: the refusal code, logged once per code, or null. */
  function startRefusal() {
    refused = authorityRefusal({ ...hot.config, memoryDb: { ...(hot.config?.memoryDb ?? {}), authority: pinnedAuthority } });
    if (refused && !refusedLogged.has(refused)) {
      refusedLogged.add(refused);
      log.warn('memory db: start refused', { code: refused, authority: pinnedAuthority });
    }
    return refused;
  }

  /** What a migration needs from the opener (open.js#migrate): the deployment's diary channel as a place. */
  const openContext = () => {
    const channel = hot.config?.diary?.channelId;
    return { diaryPlaceId: typeof channel === 'string' && channel ? channelPlaceId(channel) : null };
  };

  async function openNow() {
    if (startRefusal()) return;
    const { file } = settings();
    const dbPath = path.join(dataDir, file);
    let started = null;
    try {
      if (threaded) {
        started = startWorker({ workerFile, dataDir, log, codeOf });
        const opened = await started.call('open', { path: dbPath, context: openContext() });
        handle = open(dbPath, { readOnly: true });
        engine = started;
        importDone = opened.importDone === true;
      } else {
        handle = open(dbPath, { context: openContext() });
        importDone = meta(IMPORT_DONE) === '1';
      }
      // Authority `db`: the writes a shutdown left pending go in before anything reads (synchronous without a worker).
      if (pinnedAuthority === 'db') {
        const replay = replayPending();
        if (replay) await replay;
      }
      // Authority `db`: no sync will ever run, and the database is the memory, so it counts as in step from the start.
      lastSyncAt = settings().authority === 'db' ? now() : null;
      dirty = true;
      openErrors.clear();
      log.info('memory db: opened', { file });
      drainObservations();
      startupJobs();
    } catch (error) {
      replaying = false;
      // A replay that failed leaves the database opened: closed again (its lock released), tried at the next tick.
      if (handle) { try { handle.close(); } catch { /* already closed */ } }
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
      // The slices left the stems and the pending graph projection (sync.js): done once now, over all the import brought.
      try {
        fillStems(handle.db);
        projectPending(handle, { at: new Date(now()).toISOString() });
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
    if (settings().authority === 'db') return;
    const started = clock();
    const first = !importDone;
    dirty = false;
    try {
      let result;
      if (engine) {
        result = await engine.call('pass', { first, now: now(), authority: settings().authority });
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

  /** The stamped unit write as `writeUnit` sends it (the fixed authority, the time, a diary's destination). */
  function stampUnit(update) {
    const stamped = { ...update, kind: 'unit', authority: pinnedAuthority, now: Number.isFinite(update?.now) ? update.now : now() };
    // A diary post's destination is the deployment's diary channel (the live `diary.channelId`, as its place).
    if ((stamped.op === 'diary' || (stamped.op === 'value' && /^guilds\/[^/]+\/diary\.json$/.test(String(stamped.owner ?? '')))) && stamped.destination === undefined) {
      stamped.destination = openContext().diaryPlaceId;
    }
    return stamped;
  }

  const pendingFileOf = (owner) => path.join(pendingDir, `${createHash('sha1').update(String(owner)).digest('hex')}.json`);

  /**
   * Keeps a unit write that could not be made (unit-outbox.js#keep, at shutdown) in `memory-pending/`, replayed at the
   * next open under `db`. A value replaces the one kept for its owner; lines are appended to the kept ones. Throws on an
   * I/O failure (the caller logs it). Returns the file's path.
   * @param {{ owner: string, op: 'value'|'lines', value?: any, lines?: object[] }} update
   */
  function keepPending(update) {
    const owner = String(update?.owner ?? '');
    if (!owner || (update.op !== 'value' && update.op !== 'lines')) throw Object.assign(new Error('memory db: not a unit write'), { code: 'UNIT_BAD_OP' });
    const file = pendingFileOf(owner);
    let lines = update.op === 'lines' ? (Array.isArray(update.lines) ? update.lines : []) : null;
    if (lines) {
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (held?.owner === owner && held.op === 'lines' && Array.isArray(held.lines)) lines = [...held.lines, ...lines];
      } catch { /* nothing kept yet */ }
    }
    const kept = { owner, op: update.op, ...(lines ? { lines } : { value: update.value ?? null }), at: new Date(now()).toISOString() };
    fs.mkdirSync(pendingDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept));
    fs.renameSync(tmp, file);
    return file;
  }

  /** The pending files: [{ file, update }] (a file that does not parse is skipped and counted). */
  function pendingWrites() {
    let names = [];
    try { names = fs.readdirSync(pendingDir).filter((name) => /^[0-9a-f]{40}\.json$/.test(name)).sort(); } catch { return []; }
    const out = [];
    let bad = 0;
    for (const name of names) {
      const file = path.join(pendingDir, name);
      try {
        const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof kept?.owner !== 'string' || (kept.op !== 'value' && kept.op !== 'lines')) { bad += 1; continue; }
        out.push({ file, update: kept.op === 'value' ? { op: 'value', owner: kept.owner, value: kept.value } : { op: 'lines', mode: 'db', owner: kept.owner, lines: Array.isArray(kept.lines) ? kept.lines : [] } });
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) log.error('memory db: pending unreadable', { count: bad });
    return out;
  }

  /**
   * Replays the pending writes through the writer (open, under `db`), each file deleted once its write resolved.
   * Without a worker it runs synchronously and returns nothing; with one it returns the promise. Throws (rejects) with
   * `PENDING_REPLAY` when a write failed: its file stays.
   */
  function replayPending() {
    const writes = pendingWrites();
    if (writes.length === 0) return null;
    replaying = true;
    let failed = 0;
    let code = null;
    const done = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* removed at the next replay */ } };
    const fail = (error) => { failed += 1; code = codeOf(error); };
    const finish = () => {
      replaying = false;
      if (failed > 0) {
        log.error('memory db: pending replay failed', { count: failed, code });
        throw Object.assign(new Error('memory db: pending writes not replayed'), { code: 'PENDING_REPLAY' });
      }
      log.info('memory db: pending replayed', { count: writes.length });
    };
    if (!engine) {
      for (const { file, update } of writes) {
        try { applyMemoryWrite(handle, stampUnit(update)); done(file); } catch (error) { fail(error); }
      }
      return finish();
    }
    return (async () => {
      for (const { file, update } of writes) {
        try { await engine.call('memoryWrite', { update: stampUnit(update) }); done(file); } catch (error) { fail(error); }
      }
      finish();
    })();
  }

  /** One write on the writer connection: a message to the worker, or this thread's own connection. */
  function write(update) {
    if (!handle || closing) return Promise.reject(Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' }));
    if (engine) return engine.call('memoryWrite', { update });
    return Promise.resolve().then(() => applyMemoryWrite(handle, update));
  }

  /** What each open does once (schema v11): stale wake runs interrupted, the skills registered (each behind its switch). */
  function startupJobs() {
    const given = hot.config?.memoryDb ?? {};
    if (given.wakeRuns === true) {
      const budget = hot.config?.innerLife?.loop?.timeBudgetMs;
      write({ kind: 'wake', op: 'interrupt', now: now(), limitMs: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_TURN_BUDGET_MS })
        .then((done) => { if (done?.interrupted > 0) log.debug?.('memory db: wake runs interrupted', { runs: done.interrupted }); })
        .catch((error) => log.warn('memory db: wake interrupt failed', { code: codeOf(error) }));
    }
    if (given.skillsRegistry === true) {
      Promise.resolve()
        .then(async () => {
          const [{ SKILL_DEFINITIONS }, { NESTED_CAPABILITIES }] = await Promise.all([import('../../skills/definitions.js'), import('../../skills/access.js')]);
          const sources = opSources();
          const entries = skillVersionsOf({ definitions: SKILL_DEFINITIONS, nested: NESTED_CAPABILITIES, sourceOf: (op) => sources.get(op) ?? '', commit: typeof commit === 'string' ? commit : engineCommit() });
          return write({ kind: 'skills', entries, now: now() });
        })
        .then((done) => log.debug?.('memory db: skills registered', { skills: done?.skills ?? 0, versions: done?.versions ?? 0, stale: done?.stale ?? 0 }))
        .catch((error) => log.warn('memory db: skills registry failed', { code: codeOf(error) }));
    }
  }

  /**
   * One write of the inner life's wake runs (wakes.js#applyWakeWrite) through the writer, while `memoryDb.wakeRuns` is
   * exactly true and the database is open; else null (nothing is written).
   */
  function recordWake(update) {
    if (!handle || !on() || closing || hot.config?.memoryDb?.wakeRuns !== true || update?.kind !== 'wake') return null;
    return write(update);
  }

  /**
   * One observation of the live message path (observe.js#observe) through the writer, while `memoryDb.observeLive` is
   * exactly true and the database is open: resolves the observe result (`{ ok, ... }` or `{ ok: false, code }`).
   * Otherwise null (nothing is written). A failed write is logged with a code and resolves null: never a turn's failure.
   * `where` (`{ guildId, privateUserId }`) names the record the line belongs to: under authority `db` the observation
   * is the record of the line (its record unit is passed to observe.js), and a write that failed (not a refusal) stays
   * in the queue below and is tried again at the next tick, up to OBSERVE_ATTEMPTS times (then dropped, a warning).
   */
  // Observations that came while the database was not open yet (the start's catch-up runs before it opens) wait here
  // and are written right after it opens; a shutdown writes the waiting ones and those under way before it closes.
  // Bounded: past OBSERVE_QUEUE_MAX the oldest is dropped and counted (a warning, never silent).
  const OBSERVE_QUEUE_MAX = 5000;
  const OBSERVE_ATTEMPTS = 5;
  const observeQueue = [];
  const observing = new Set();
  let observeDropped = 0;
  const observeOn = (envelope) => on() && hot.config?.memoryDb?.observeLive === true && envelope !== null && typeof envelope === 'object';

  /** The record unit of an observed line under authority `db` (record.js#dayFile's day: the UTC day of the line), or null. */
  function recordUnitOf(envelope, where) {
    if (pinnedAuthority !== 'db') return null;
    const guildId = where?.guildId;
    const day = /^\d{4}-\d{2}-\d{2}/.exec(String(envelope?.occurredAt ?? ''))?.[0];
    if (typeof guildId !== 'string' || !guildId || !day) return null;
    const layer = typeof where.privateUserId === 'string' && where.privateUserId ? `guilds/${guildId}/private/${where.privateUserId}` : `guilds/${guildId}`;
    return `${layer}/record/${day.slice(0, 7)}/${day}.jsonl`;
  }

  /** Queues an observation (bounded: the oldest goes first, counted). */
  function queueObservation(item) {
    observeQueue.push(item);
    if (observeQueue.length > OBSERVE_QUEUE_MAX) {
      observeQueue.shift();
      observeDropped += 1;
      log.warn('memory db: observe dropped', { reason: 'queue_full', dropped: observeDropped });
    }
  }

  function sendObservation(item) {
    const { envelope, owner } = item;
    const done = (engine
      ? engine.call('observe', { envelope, now: now(), owner })
      : Promise.resolve().then(() => observeEnvelope(handle, envelope, { now, log, owner })))
      .then((result) => {
        if (result && result.ok === false) log.warn('memory db: observe refused', { code: result.code ?? null });
        return result;
      })
      .catch((error) => {
        log.warn('memory db: observe failed', { code: codeOf(error) });
        // Under `db` the observation is the line's only record: it waits for the next tick, never for a file.
        if (pinnedAuthority === 'db') {
          const attempts = (item.attempts ?? 0) + 1;
          if (attempts < OBSERVE_ATTEMPTS) queueObservation({ ...item, attempts });
          else {
            observeDropped += 1;
            log.warn('memory db: observe dropped', { reason: 'retries', dropped: observeDropped });
          }
        }
        return null;
      });
    observing.add(done);
    done.finally(() => observing.delete(done));
    return done;
  }

  function observe(envelope, where = null) {
    if (!observeOn(envelope)) return null;
    const item = { envelope, owner: recordUnitOf(envelope, where), attempts: 0 };
    if (!handle) {
      if (closed) {
        observeDropped += 1;
        log.warn('memory db: observe dropped', { reason: 'closed', dropped: observeDropped });
        return null;
      }
      queueObservation(item);
      return null;
    }
    return sendObservation(item);
  }

  /** Writes the observations that waited (for the database to open, or for a retry), in arrival order. */
  function drainObservations() {
    if (!handle || observeQueue.length === 0) return;
    const waiting = observeQueue.splice(0, observeQueue.length);
    log.info('memory db: observations written after open', { count: waiting.length });
    for (const item of waiting) sendObservation(item);
  }

  /**
   * One write of an append-like memory unit (unit-write.js) through the writer, stamped with the fixed authority.
   * Resolves the writer's counts once committed; rejects with a code (`DB_CLOSED` while the database is not open). A
   * record line's shadow (op `lines`, mode `shadow`) resolves null, writing nothing, unless `memoryDb.observeLive` is
   * exactly true.
   */
  async function writeUnit(update) {
    // A shadow of a record line (authority `json`) belongs to the live observation path: nothing without its switch.
    if (update?.op === 'lines' && update?.mode === 'shadow' && hot.config?.memoryDb?.observeLive !== true) return null;
    if (!handle || !on() || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    const stamped = stampUnit(update);
    if (engine) return engine.call('memoryWrite', { update: stamped });
    return applyMemoryWrite(handle, stamped);
  }

  // Under `db` no sync pass finishes the graph projection a migration left pending or the stems of new lines: the
  // writer does, one slice per tick (unit-write.js, op `project`).
  let projectRun = null;
  function startProject() {
    if (closing || !on() || !handle || projectRun || engine?.dead || pinnedAuthority !== 'db') return;
    let due = false;
    try { due = graphPending(handle) || stemsPending(handle.db); } catch { due = false; }
    if (!due) return;
    projectRun = writeUnit({ op: 'project', maxSlices: 1 })
      .then((done) => { if (done?.units > 0 || done?.stems > 0) log.debug?.('memory db: projected', { units: done.units, stems: done.stems, done: done.done }); })
      .catch((error) => log.warn('memory db: projection failed', { code: codeOf(error) }))
      .finally(() => { projectRun = null; });
  }

  /** Shutdown: the waiting observations are written, then every one under way is awaited. */
  async function flushObservations(timeoutMs) {
    drainObservations();
    await waitFor(Promise.allSettled([...observing]), timeoutMs);
  }

  /** The sources `ids` were read by a request or a session: touched (index-policy.js#touch) while eviction is on. */
  function touchSources(ids) {
    if (!handle || !on() || closing || !indexSettings(hot.config).eviction) return;
    const sources = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (sources.length === 0) return;
    write({ kind: 'touch', sourceIds: sources, now: now(), config: { recall: { db: hot.config?.recall?.db ?? {} } } })
      .catch((error) => log.warn('memory db: touch failed', { code: codeOf(error) }));
  }

  // The index policy (index-policy.js): once per UTC day while `recall.db.vectorEviction` is on, through the writer.
  let indexRun = null;
  let indexDay = null;
  function startIndexPolicy() {
    if (closing || !on() || !handle || !importDone || indexRun || engine?.dead) return;
    if (!indexSettings(hot.config).eviction) return;
    const at = now();
    const day = utcDay(at);
    if (indexDay === day) return;
    indexRun = write({ kind: 'index-policy', now: at, config: { recall: { db: hot.config?.recall?.db ?? {} } } })
      .then((done) => {
        indexDay = day;
        log.debug?.('memory db: index policy', { a: done?.tiers?.a ?? 0, b: done?.tiers?.b ?? 0, c: done?.tiers?.c ?? 0, evicted: done?.evicted ?? 0 });
      })
      .catch((error) => log.warn('memory db: index policy failed', { code: codeOf(error) }))
      .finally(() => { indexRun = null; });
  }

  // The re-embed job (index-policy.js#reembedTouched): `recall.db.reembed` with an embedding client, at most once a minute.
  let reembedRun = null;
  let reembedAt = -Infinity;
  function startReembed() {
    if (closing || !on() || !handle || !importDone || reembedRun || engine?.dead || typeof embed !== 'function') return;
    if (!indexSettings(hot.config).reembed) return;
    const at = now();
    if (at - reembedAt < REEMBED_EVERY_MS) return;
    reembedAt = at;
    const db = handle.db;
    reembedRun = (async () => {
      const [{ quantize }, { recordChunk }, { roleModel }] = await Promise.all([import('../vectors.js'), import('../chunks.js'), import('../../llm/roles.js')]);
      const config = hot.config;
      const nameOf = (id) => {
        try {
          const names = JSON.parse(db.prepare('SELECT names FROM accounts WHERE native_id = ? LIMIT 1').get(id)?.names ?? 'null');
          return Array.isArray(names) && typeof names[0] === 'string' ? names[0] : null;
        } catch {
          return null;
        }
      };
      return reembedTouched({ db, write, embed, config, now: at, quantize, model: roleModel(config, 'embedding') ?? null, chunkOf: (line, context) => recordChunk(line, context, { nameOf, selfName: selfName() ?? '' }).text });
    })()
      .then((done) => { if (done.pending > 0) log.debug?.('memory db: reembed', { pending: done.pending, embedded: done.embedded, written: done.written, skipped: done.skipped }); })
      .catch((error) => log.warn('memory db: reembed failed', { code: codeOf(error) }))
      .finally(() => { reembedRun = null; });
  }

  // The focus job (focus.js): once per UTC day, through the writer, with the live settings.
  let focusRun = null;
  let focusDay = null;
  function startFocus() {
    if (closing || !on() || !handle || !importDone || focusRun || engine?.dead) return;
    if (hot.config?.memoryDb?.focus?.enabled !== true) return;
    const at = now();
    const day = utcDay(at);
    if (focusDay === day) return;
    try {
      if (lastFocusDay(handle.db) === day) { focusDay = day; return; }
    } catch { /* a database before v10: the job runs and fails with a code */ }
    const config = { focus: hot.config?.focus ?? null };
    const job = engine ? engine.call('focus', { now: at, config }) : Promise.resolve().then(() => runFocusDay(handle, { now: at, config }));
    focusRun = job
      .then((done) => {
        focusDay = day;
        log.debug?.('memory db: focus', { days: done.days, rows: done.rows, close: done.close, exploring: done.exploring, events: done.events });
      })
      .catch((error) => log.warn('memory db: focus failed', { code: codeOf(error) }))
      .finally(() => { focusRun = null; });
  }

  /**
   * The focus sets for the heartbeat's people view (focus.js#focusView, an internal read): `{ close, exploring,
   * exploringShare }` as member ids of the interface, each the best scored first; null while the database is closed.
   */
  function focusPeople({ iface = 'discord' } = {}) {
    if (!handle || !on()) return null;
    try {
      const sets = focusView(handle.db, { iface });
      const share = hot.config?.focus?.exploringShare;
      return { ...sets, exploringShare: Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.15 };
    } catch (error) {
      log.warn('memory db: focus read failed', { code: codeOf(error) });
      return null;
    }
  }

  /**
   * The readers' authority, fixed when the service was created; a different live value is logged once and ignored.
   * @returns {'json'|'db'}
   */
  function authority() {
    const asked = hot.config?.memoryDb?.authority === 'db' ? 'db' : 'json';
    if (asked !== pinnedAuthority && !authorityChanges.has(asked)) {
      authorityChanges.add(asked);
      log.warn('memory db: authority change needs a restart', { running: pinnedAuthority, asked });
    }
    return pinnedAuthority;
  }

  /** The read-only connection (`{ db }`) while the switch is on and the database is open, else null. */
  const readHandle = () => (on() && handle !== null && !closed && !replaying ? handle : null);

  /** The tick: follows the switch, runs a pass when one is due. Safe to call at any rate. */
  async function tick() {
    if (closing) return;
    authority();
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
    // Authority `db`: the sync stays off; the writers' own jobs run instead (the waiting observations, the projection).
    if (pinnedAuthority === 'db') { drainObservations(); startProject(); startDiaryMedia(); startFocus(); startIndexPolicy(); startReembed(); return; }
    if (dirty || lastSyncAt === null || now() - lastSyncAt >= settings().syncMs) await runPass('tick');
    startDiaryMedia();
    startFocus();
    startIndexPolicy();
    startReembed();
  }

  /** A flush wrote files: a pass soon, off the caller's path. */
  function requestSync() {
    dirty = true;
    if (!on() || closing || settings().authority === 'db') return;
    defer(() => { tick().catch((error) => log.warn('memory db: tick failed', { code: codeOf(error) })); });
  }

  const readActive = () => on() && settings().read && handle !== null && importDone && lastSyncAt !== null && !replaying;
  const count = (key) => { reads[key] += 1; return null; };

  /**
   * The database for recall (src/memory/db/recall.js, `recall.backend` `db`): the read-only connection while the
   * switch is on, this process has synced once and the first import is done; else null (recall then reads as it did).
   */
  const database = () => (on() && handle !== null && importDone && lastSyncAt !== null ? handle.db : null);

  /** What the store reads through (store.js `memoryRead`). */
  const reader = {
    value(file) {
      // Authority `db`: the database alone answers (stage W2b); a unit it does not hold is absent, never the disk's.
      if (pinnedAuthority === 'db') {
        if (!on() || handle === null || replaying || closed) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
        try {
          const found = exportOne(handle, root.relative(file));
          if (found.found) reads.db += 1;
          else count(found.reason in reads ? found.reason : 'missing');
          return found;
        } catch (error) {
          reads.errors += 1;
          log.warn('memory db: read failed', { code: codeOf(error) });
          throw error;
        }
      }
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
   * `contextId` is the execution context of the read (`issueContext`), `readerKind` `turn` (default), `session` or `wake`.
   * @param {{ turnId: string, step?: string, guildId?: string|null, reads: { kind: string, id: string }[], contextId?: string|null, readerKind?: string }} args
   */
  function recordTurnReads({ turnId, step = 's0', guildId = null, reads: carried, contextId = null, readerKind = 'turn' }) {
    if (!handle || !on() || !settings().turnReads || !turnId || !Array.isArray(carried) || carried.length === 0) return;
    // Resolved now, from the rows as they are when the request is assembled; only the write waits for a quiet loop.
    let rows;
    try {
      rows = turnReadRows(handle.db, carried, { guildId });
    } catch (error) {
      log.warn('memory db: turn reads failed', { code: codeOf(error) });
      return;
    }
    if (rows.length === 0) return;
    const context = typeof contextId === 'string' ? contextId : '';
    const reader = READER_KINDS.includes(readerKind) ? readerKind : 'turn';
    rows = rows.map((row) => ({ ...row, context_id: context, reader_kind: reader }));
    // The lines a request carried were shown to her: touched while eviction is on (their vectors come back).
    touchSources(rows.filter((row) => row.row_kind === 'sources').map((row) => row.row_id));
    // The write waits for a quiet loop, but a shutdown never drops it: `close` runs every write still queued, then waits
    // for the ones under way, before the database closes.
    const job = { run: null, done: null };
    job.run = () => {
      if (job.done) return job.done;
      pendingReads.delete(job);
      job.done = (async () => {
        if (engine && !engine.dead) {
          try {
            const done = await engine.call('turnReads', { turnId: String(turnId), step: String(step), rows });
            if (done.rows > 0) log.debug?.('memory db: turn reads', { rows: done.rows });
          } catch (error) {
            log.warn('memory db: turn reads failed', { code: codeOf(error) });
          }
          return;
        }
        if (!handle || engine) return;
        try {
          insertTurnReads(handle, turnId, step, rows);
          log.debug?.('memory db: turn reads', { rows: rows.length });
        } catch (error) {
          log.warn('memory db: turn reads failed', { code: codeOf(error) });
        }
      })();
      writingReads.add(job.done);
      job.done.finally(() => writingReads.delete(job.done));
      return job.done;
    };
    pendingReads.add(job);
    defer(job.run);
  }

  /** Runs every queued turn-reads write now and waits for all of them (shutdown). */
  async function flushTurnReads(timeoutMs) {
    for (const job of [...pendingReads]) job.run();
    await waitFor(Promise.allSettled([...writingReads]), timeoutMs);
  }

  /**
   * One write of her memory session or a description review (session-write.js), on the writer connection: a message
   * to the worker, or the calling thread's own connection when there is no worker. Rejects when the database is closed.
   */
  async function memoryWrite(update) {
    if (!handle || !on() || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    // Who writes is the service's (fixed for the process), never the caller's; the read predicate of the target check is
    // the live config's.
    const stamped = { ...update, authority: settings().authority, audienceColumn: hot.config?.memoryDb?.audienceColumn === true };
    // A session's batch read its lines: touched while eviction is on.
    if (update?.kind === 'session' && Array.isArray(update.reads)) touchSources(update.reads.filter((row) => row?.row_kind === 'sources').map((row) => row.row_id));
    if (engine) return engine.call('memoryWrite', { update: stamped });
    return applyMemoryWrite(handle, stamped);
  }

  /**
   * Issues an execution context for one turn, session or wake (scope.js#issueContext), read through `audience_id` when
   * `memoryDb.audienceColumn` is on. While the database is open the context is recorded in `execution_contexts`,
   * deferred through the writer (a failure is logged with a code); otherwise it is only the object.
   * @param {{ kind: 'group'|'dm'|'internal', iface?: string, person?: string, place?: string|null, destination?: string|null }} spec
   */
  function issueContext(spec = {}) {
    const ctx = issuePureContext({ ...spec, now, audienceColumn: hot.config?.memoryDb?.audienceColumn === true });
    if (!handle || !on() || closing) return ctx;
    const update = { kind: 'context', context: contextRow(ctx) };
    defer(() => {
      if (!handle || closing) return;
      const done = engine ? (engine.dead ? null : engine.call('memoryWrite', { update })) : Promise.resolve().then(() => applyMemoryWrite(handle, update));
      done?.catch((error) => log.warn('memory db: context record failed', { code: codeOf(error) }));
    });
    return ctx;
  }

  /** The state for the status card: on/off, rows, the last pass, how far behind it is, the read switch. */
  function status() {
    const open = handle !== null;
    let rows = null;
    let files = null;
    if (open) {
      try {
        files = handle.db.prepare('SELECT COUNT(*) AS n FROM files WHERE gone_at IS NULL').get().n;
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
      lagSeconds: open && lastSyncAt !== null && settings().authority !== 'db' ? Math.max(0, Math.round((now() - lastSyncAt) / 1000)) : null,
      authority: pinnedAuthority,
      syncOff: on() && pinnedAuthority === 'db',
      refused,
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
    await waitFor(focusRun, Math.max(0, deadline - performance.now()));
    await waitFor(indexRun, Math.max(0, deadline - performance.now()));
    await waitFor(reembedRun, Math.max(0, deadline - performance.now()));
    await waitFor(projectRun, Math.max(0, deadline - performance.now()));
    await flushTurnReads(Math.max(0, deadline - performance.now()));
    await flushObservations(Math.max(0, deadline - performance.now()));
    if (handle && on() && importDone && !running && !engine?.dead && settings().authority !== 'db') {
      try { await waitFor(runPass('shutdown'), Math.max(0, deadline - performance.now())); } catch { /* logged inside */ }
    }
    await closeNow(Math.max(0, deadline - performance.now()));
    closed = true;
  }

  return { tick, requestSync, reader, database, authority, readHandle, recordTurnReads, memoryWrite, writeUnit, keepPending, recordWake, issueContext, observe, focusPeople, status, close };
}
