// The memory database inside the bot (spec 2026-10-24-memory-store, sections 5, 7 and 10): the one memory.
//
// `createMemoryDb({ hot, dataDir, log, now })` opens `data/<memoryDb.file>` with the writer lock and keeps it open while
// the bot runs; every memory module reads it and writes it through this service:
//   - `tick()` opens the database when it is not open yet. A refused open (a live holder of the lock, a broken file) is
//     logged once per code and tried again at the next tick; the bot never waits for it but at its start (src/index.js
//     awaits the first tick before anything reads the memory).
//   - `readHandle()` is the read-only connection while the database is open (null otherwise): what the memory modules'
//     readers read through (src/memory/db/readers/), and `database()` its raw connection for recall
//     (src/memory/db/recall.js).
//   - `recordTurnReads` resolves the memory rows one step's request carried when it is called, at assembly time, on the
//     read connection (the block each was in, its order, the exact claim / description version and source revision),
//     and writes the turn_reads rows deferred, one transaction (`memoryDb.turnReads`). The persistence is deferred; the
//     resolution is not, so a later write cannot change which version a turn is said to have read.
//   - `memoryWrite` is the one way her memory session and the description review write (session-write.js): a message to
//     the worker, so the bot's loop never holds a write transaction. The service stamps `memoryDb.audienceColumn` (the
//     read predicate of the target check) into every write. After an apply, its committed attitude moves are told
//     once to the subscribers of `onAffinityMoves(fn)` (the store, whose cached profiles would otherwise write an older
//     score over them).
//   - `status().observe` counts the observations waiting for the database (`queued`), under way (`writing`) and lost
//     (`dropped`: the bounded queue's oldest, a write that failed every retry, one the shutdown could not write);
//     `waitObservations()` writes the waiting ones and awaits them.
//   - `issueContext(spec)` issues an execution context (scope.ts#issueContext: an id, the mode, the destination) read
//     through the triple or `audience_id` as `memoryDb.audienceColumn` says, and records it in `execution_contexts`
//     (deferred, through the writer) while the database is open; closed, the context is a pure object all the same.
//     `recordTurnReads` stores the context id (`contextId`, '' without one) and the reader kind (`turn` by default).
//   - the focus job (schema v10, focus.js; `memoryDb.focus.enabled`, off by default): once per UTC day, at a tick, the
//     relationship counts of yesterday and today are recounted and the close and exploring sets recomputed, through the
//     writer (the worker), with the live `focus` settings. `focusPeople()` reads the sets for the heartbeat's people
//     view on the read connection (an internal reader), with `focus.exploringShare`; null while the database is closed.
//   - schema v11 (wakes.js, skills.js, index-policy.js), every part behind its own switch, all off by default:
//       `memoryDb.wakeRuns`: `recordWake(update)` is the inner life's one way to write its wake runs (src/behavior/
//       inner.ts), through the writer; at each open the runs a dead process left `running` longer than the inner
//       turn's time budget (`innerLife.loop.timeBudgetMs`) become `interrupted`.
//       `memoryDb.skillsRegistry`: at each open every skill of src/tools/definitions.ts is registered with its
//       content hash (its definition and its operation's source file under src/tools/impl/), its manifest and the engine
//       commit (`git rev-parse HEAD`, else `unknown`; `commit` injects it).
//       `recall.db.vectorEviction`: once per UTC day, at a tick, the index policy classifies every line and evicts
//       the vectors outside the owner's classes, through the writer; the sources a turn's request carried
//       (`recordTurnReads`) and a memory session's batch read (`memoryWrite`) are touched, so their vectors come back.
//       `recall.db.reembed` (with an injected `embed`, the embedding client): at most once a minute, at a tick, the
//       touched lines' evicted vectors are embedded again (index-policy.js#reembedTouched) on this thread, and written
//       through the writer.
//   - `observe(envelope, where)`: one observation of the live message path (observe.js#observe, the envelope from
//     observe-event.js#observationOf) through the writer, like every other write: the observation is the record of the
//     line (`where` names its layer). Never throws.
//   - `writeUnit(update)` (unit-write.js): the database writers of the memory units (record and journal lines, the
//     store's cache, the module stores, participation, the diary, the vectors) through the writer; resolves once the
//     worker committed, rejects with a code (`DB_CLOSED` while the database is not open). Each tick also finishes the
//     graph projection and the stems a migration left (one slice a tick). The opener's migration context is the live
//     `diary.channelId`'s place (the seed of schema v12's and v15's data steps); a diary write's destination is the
//     place of the diary's first enabled mirror. The durable intent of a write that failed (spec
//     2026-10-24-memory-authority, section 6 item 3): `keepPending(update)` (at shutdown, from unit-outbox.js#keep)
//     writes it to `data/memory-pending/<sha1 of the owner>.json` (`{ owner, op, value | lines, at }`; the lines of one
//     owner are appended to what its file holds), and every open replays each pending file through the writer before
//     anything reads the database (`readHandle()` answers nothing meanwhile), deleting a file only after its write
//     resolved. A replay that fails keeps its file, logs `memory db: pending replay failed` (an error, with the count)
//     and fails the open (`PENDING_REPLAY`): the database is not used behind a write it has not taken.
//   - her memory session is the memory writer (spec 2026-10-24-memory-authority, section 6 item 7). Each open logs the
//     effective models (`memory db: effective models`: purpose, model id and key variable of the memory session, the
//     description review and every other purpose; writer-switch.js#effectiveModels). With `memoryDb.session.mode`
//     `apply`, an LLM client (`sessionLlm`) and the key of the memory role (`sessionEnv`), a tick looks at most once a
//     minute for due scopes (writer-switch.js#dueScopes: `minMessages` settled lines and `everyMinutes` since the
//     scope's last run or `maxMessages` waiting, under the per-scope daily cap) and runs one sweep over them
//     (session.js#sweep), then the description reviews her flags ask for (writer-switch.js#openFlags, at most
//     `memoryDb.session.reviewsPerDay` accepted or failed a UTC day; describe.js#reviewDescription). Never two at once;
//     every write through the writer. A run that fails (`llm_error`, `bad_answer`, `build_error`, `write_failed`,
//     `not_configured`, `skipped`) is a warning (`memory session: run failed`, the code and the scope kind), the
//     status's `session.lastFailure`, and one `onSessionFailure({ scopeKey, scopeKind, partner, code, lines, at })` per
//     failing scope until that scope runs fine again (src/index.js tells her: a `memoryFailed` fact); a failed review
//     is a warning and the status's `session.lastFailure`, and its flag waits for the next day.
//   - the daily backup (backup.js), while `memoryDb.backup.enabled` is exactly true (read at each tick). At a tick at
//     or after `memoryDb.backup.hour` (UTC) on a UTC day with no finished backup in `memoryDb.backup.dir` (resolved
//     against the data directory; default `../backups/memory`, outside `data/`), the writer takes it (`{ kind: 'backup' }`:
//     `VACUUM INTO` on the writer connection, the diary media, the manifest with the schema version, the engine commit
//     (`commit`, else `git rev-parse HEAD`), the hash of the live config and the row count of every table) into
//     `<YYYY-MM-DD-HHMMSS>-memory.partial/`, renamed to its name once whole; then all but the newest
//     `memoryDb.backup.keep` backups and every other unfinished one are deleted. Never two at once. A failure is a
//     warning (`memory db: backup failed`, the code), the status's `backup.lastFailure`, and one
//     `onBackupFailure({ code, at })` per UTC day (her fact); it is tried again an hour later.
//   - `close()` waits for the jobs under way, writes the turn reads and the observations still waiting, closes the
//     database and releases the lock. The waits are bounded by `memoryDb.closeTimeoutMs` (default 10000); then the
//     worker is terminated.
//
// Threads. By default the writer connection, the lock and every write live in a worker thread (writer-worker.js); the
// main thread keeps a read-only connection, which is all the readers and the status card need (WAL: readers never wait
// for the writer). turn_reads go to the worker as messages rather than being written from the main thread: a second
// writer would wait out the worker's write transaction (up to the busy timeout) on the bot's own loop. A worker that
// exits or crashes is logged with a code, its calls fail, and the next tick opens a new one (the dead one's lock is
// ours to take over). The main thread never runs a mapper. Injecting `open` (the tests), or `worker: false`, keeps
// everything on the calling thread.
// Counts and codes only in the logs, never a path, a name or a text.

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { lockPathOf, openMemoryDb } from './open.js';
import { channelPlaceId, guildPlaceId, nativeAuthorityOf } from './ids.ts';
import { LEGACY_IFACE, liveIface, withLiveIface } from './legacy-namespace.ts';
import { contextRow, issueContext as issuePureContext } from './scope.ts';
import { applyDiaryUpdate, createDiaryMedia } from './diary-media.js';
import { NEWEST_CLAIM_VERSION_SQL, applyMemoryWrite, writeTurnReadRows } from './session-write.js';
import { focusView, lastFocusDay, runFocusDay } from './focus.js';
import { utcDay } from '../../time.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skillVersionsOf } from './skills.js';
import { indexSettings, reembedTouched } from './index-policy.js';
import { observe as observeEnvelope } from './observe.js';
import { graphPending } from './graph.js';
import { stemsPending } from './stems.js';
import { createHash } from 'node:crypto';
import { backupName, backupOn, backupSettings, configHash, partialOf, pruneBackups } from './backup.js';
import { mirrorPlaces, readMirrors } from './mirrors.ts';

/** The folder of the unit writes that failed at a shutdown (stage W2b), under the data directory. */
export const PENDING_DIR = 'memory-pending';

const DEFAULT_FILE = 'memory.db';
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
/** The inner turn's time budget when `innerLife.loop.timeBudgetMs` is not set (config.json's value). */
const DEFAULT_TURN_BUDGET_MS = 180_000;
/** The least time between two runs of the re-embed job. */
const REEMBED_EVERY_MS = 60_000;
/** The least time between a failed daily backup and the next try. */
const BACKUP_RETRY_MS = 3_600_000;
const OPS_DIR = new URL('../../tools/impl/', import.meta.url);
const ENGINE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The source text of each operation's module under src/tools/impl/ (op name -> the file's text). */
export function opSources(dir = OPS_DIR) {
  const out = new Map();
  for (const name of fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .sort()) {
    const text = fs.readFileSync(new URL(name, dir), 'utf8');
    for (const match of text.matchAll(/defineOp\(\{\s*name:\s*'([^']+)'/g)) out.set(match[1], text);
  }
  return out;
}

/** The engine's commit (`git rev-parse HEAD` in the checkout), or 'unknown'. */
export function engineCommit(cwd = ENGINE_ROOT) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}
const WORKER_FILE = new URL('./writer-worker.js', import.meta.url);
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

/**
 * The turn_reads rows of one `memoryReads` list (prompt.js#buildRequest), resolved against the database now:
 * `{ row_kind, row_id, block, ord, version_id, revision }`. `block` and `ord` are the block the read sat in and its place
 * in the request; `version_id` is the newest claim version or the current description version; `revision` a source's.
 * Besides the kinds her turns name, a read may name a row by its database id (her memory session's request does):
 * `source_id`, `description`, `place`, `intention`.
 */
export function turnReadRows(db, reads, { guildId = null, iface = LEGACY_IFACE } = {}) {
  const authority = nativeAuthorityOf(iface);
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
    rows.set(key, {
      row_kind: rowKind,
      row_id: rowId,
      block: typeof read.block === 'string' ? read.block : null,
      ord: Number.isInteger(read.ord) ? read.ord : at,
      version_id: versionId,
      revision,
    });
  };
  const hasRow = (table, id) => db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE id = ? LIMIT 1`).get(id) !== undefined;
  // A message id is native to one authority: the turn's interface, never matched alone.
  const latestMessage = db.prepare(
    "SELECT id FROM sources WHERE native_id = ? AND authority_id IS ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1"
  );
  for (const read of Array.isArray(reads) ? reads : []) {
    at += 1;
    const id = read?.id === undefined || read?.id === null ? '' : String(read.id);
    if (!id) continue;
    switch (read.kind) {
      case 'claim':
        put('claims', id, read);
        break;
      case 'episode':
        put('episodes', id, read);
        break;
      case 'participation':
        put('episodes', id, read);
        break;
      case 'recent_line':
        put('claims', id, read);
        break;
      case 'lore':
        put('claims', `lore:${id}`, read);
        break;
      case 'channel':
        put('places', channelPlaceId(iface, id), read);
        break;
      case 'guild_note':
        if (guildId) put('descriptions', `desc:${guildPlaceId(iface, guildId)}:${id}`, read);
        break;
      case 'item':
        if (hasRow('claims', id)) put('claims', id, read);
        else if (hasRow('episodes', id)) put('episodes', id, read);
        break;
      case 'source': {
        const found = latestMessage.get(id, authority);
        if (found) put('sources', found.id, read);
        break;
      }
      case 'source_id':
        put('sources', id, read);
        break;
      case 'description':
        put('descriptions', id, read);
        break;
      case 'place':
        put('places', id, read);
        break;
      case 'intention':
        put('intentions', id, read);
        break;
      default:
        break;
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
    await Promise.race([
      promise.catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the writer worker. `call(type, payload)` posts one message and resolves with the worker's reply (a rejection
 * carries the worker's `code`); when the worker exits or fails, `dead` turns true, the calls under way reject with
 * `WORKER_EXIT` (or the error's code) and the exit is logged once, with a code and the exit code only.
 */
function startWorker({ workerFile, log, codeOf }) {
  const worker = new Worker(workerFile);
  worker.unref();
  const pending = new Map();
  let seq = 0;
  let stopping = false;
  let logged = false;
  let exited = false;
  let onExit;
  const exit = new Promise((resolve) => {
    onExit = resolve;
  });
  const engine = { dead: false, call, stop };

  function fail(code) {
    engine.dead = true;
    for (const waiting of pending.values())
      waiting.reject(Object.assign(new Error('memory db worker stopped'), { code }));
    pending.clear();
  }

  function call(type, payload = {}) {
    if (engine.dead)
      return Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' }));
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
    if (!logged && !stopping) {
      logged = true;
      log.warn('memory db: worker failed', { code: codeOf(error) });
    }
    fail(codeOf(error));
  });
  worker.on('exit', (exitCode) => {
    exited = true;
    if (!logged && !stopping) {
      logged = true;
      log.warn('memory db: worker exited', { code: 'WORKER_EXIT', exit: exitCode });
    }
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
      } catch {
        /* no lock, or not ours */
      }
    }
  }

  return engine;
}

/** What a migration needs from the opener (open.js#migrate): the diary channel as a place, and the data directory. */
function openContextOf(config, dataDir) {
  const channel = config?.diary?.channelId;
  return {
    diaryPlaceId: typeof channel === 'string' && channel ? channelPlaceId(LEGACY_IFACE, channel) : null,
    dataDir,
  };
}

/**
 * @param {{ hot: { config: object }, dataDir: string, log?: object, now?: () => number,
 *   open?: typeof openMemoryDb, defer?: (fn: () => void) => void, worker?: boolean, iface?: () => string | null,
 *   diaryMediaDeps?: () => ({ port: object, imageFetcher: object }|null) }} options
 *   `diaryMediaDeps` (read at each tick) gives the interface port and the image fetcher the diary media job needs
 *   (`memoryDb.diaryMedia`, diary-media.js); without it the job does nothing.
 *   `defer` runs a function on the next turn of the event loop (setImmediate), injected by the tests.
 *   `embed` is the embedding client's `embed(texts, { config, purpose })` (the re-embed job; none: the job does
 *   nothing), `commit` the engine commit for the skills registry (default `git rev-parse HEAD`), `selfName()` her name
 *   in a rebuilt embedding input.
 */
export function createMemoryDb({
  hot,
  dataDir,
  log = silent,
  now = Date.now,
  open,
  defer = (fn) => setImmediate(fn),
  worker: useWorker,
  workerFile = WORKER_FILE,
  diaryMediaDeps = null,
  diarySleep,
  embed = null,
  commit = null,
  selfName = () => '',
  sessionLlm = () => null,
  sessionEnv = () => null,
  onSessionFailure = null,
  sessionLookMs = 60_000,
  onBackupFailure = null,
  iface = () => null,
}) {
  const threaded = useWorker ?? open === undefined;
  open ??= openMemoryDb;
  let handle = null;
  let engine = null;
  let openedAt = null;
  const pendingReads = new Set();
  const writingReads = new Set();
  let closing = false;
  let closed = false;
  const openErrors = new Set();

  const settings = () => {
    const given = /** @type {Record<string, unknown>} */ (hot.config?.memoryDb ?? {});
    const closeMs = given.closeTimeoutMs;
    return {
      file: typeof given.file === 'string' && given.file ? given.file : DEFAULT_FILE,
      turnReads: given.turnReads !== false,
      closeMs:
        typeof closeMs === 'number' && Number.isFinite(closeMs) && closeMs > 0 ? closeMs : DEFAULT_CLOSE_TIMEOUT_MS,
    };
  };
  const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';

  // While the pending unit writes of the last shutdown are replayed at an open, nothing reads the database.
  let replaying = false;
  const pendingDir = path.join(dataDir, PENDING_DIR);

  // What a migration needs from the opener (openContextOf).
  const openContext = () => openContextOf(hot.config, dataDir);

  async function openNow() {
    const { file } = settings();
    const dbPath = path.join(dataDir, file);
    let started = null;
    try {
      if (threaded) {
        started = startWorker({ workerFile, log, codeOf });
        await started.call('open', { path: dbPath, context: openContext() });
        handle = open(dbPath, { readOnly: true });
        engine = started;
      } else {
        handle = open(dbPath, { context: openContext() });
      }
      // The writes a shutdown left pending go in before anything reads (synchronous without a worker).
      const replay = replayPending();
      if (replay) await replay;
      openedAt = now();
      openErrors.clear();
      log.info('memory db: opened', { file });
      await logEffectiveModels();
      drainObservations();
      startupJobs();
    } catch (error) {
      replaying = false;
      // A replay that failed leaves the database opened: closed again (its lock released), tried at the next tick.
      if (handle) {
        try {
          handle.close();
        } catch {
          /* already closed */
        }
      }
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
      try {
        handle.close();
      } catch (error) {
        log.warn('memory db: close failed', { code: codeOf(error) });
      }
    }
    const worker = engine;
    handle = null;
    engine = null;
    openedAt = null;
    if (worker) await worker.stop(timeoutMs, lockPathOf(path.join(dataDir, settings().file)));
    log.info('memory db: closed', {});
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
    if (closing || !handle) return;
    if (hot.config?.memoryDb?.diaryMedia !== true || engine?.dead) return;
    if (!diaryJob.hasWork()) return;
    diaryJob.run().catch((error) => log.warn('diary media: run failed', { code: codeOf(error) }));
  }

  /** The stamped unit write as `writeUnit` sends it (the time, a diary's destination). */
  function stampUnit(update) {
    const stamped = { ...update, kind: 'unit', now: Number.isFinite(update?.now) ? update.now : now() };
    // A diary post's destination is the place of the diary's first enabled mirror (mirrors.ts).
    if (
      (stamped.op === 'diary' ||
        (stamped.op === 'value' && /^guilds\/[^/]+\/diary\.json$/.test(String(stamped.owner ?? '')))) &&
      stamped.destination === undefined
    ) {
      stamped.destination = readMirrors({ readHandle }, mirrorPlaces, [])[0]?.placeId ?? null;
    }
    return withLiveIface(stamped, iface);
  }

  const pendingFileOf = (owner) =>
    path.join(pendingDir, `${createHash('sha1').update(String(owner)).digest('hex')}.json`);

  /**
   * Keeps a unit write that could not be made (unit-outbox.js#keep, at shutdown) in `memory-pending/`, replayed at the
   * next open. A value replaces the one kept for its owner; lines are appended to the kept ones. Throws on an
   * I/O failure (the caller logs it). Returns the file's path.
   * @param {{ owner: string, op: 'value'|'lines', value?: any, lines?: object[] }} update
   */
  function keepPending(update) {
    const owner = String(update?.owner ?? '');
    if (!owner || (update.op !== 'value' && update.op !== 'lines'))
      throw Object.assign(new Error('memory db: not a unit write'), { code: 'UNIT_BAD_OP' });
    const file = pendingFileOf(owner);
    let lines = update.op === 'lines' ? (Array.isArray(update.lines) ? update.lines : []) : null;
    if (lines) {
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (held?.owner === owner && held.op === 'lines' && Array.isArray(held.lines))
          lines = [...held.lines, ...lines];
      } catch {
        /* nothing kept yet */
      }
    }
    const kept = {
      owner,
      op: update.op,
      ...(lines ? { lines } : { value: update.value ?? null }),
      at: new Date(now()).toISOString(),
    };
    fs.mkdirSync(pendingDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept));
    fs.renameSync(tmp, file);
    return file;
  }

  /** The pending files: [{ file, update }] (a file that does not parse is skipped and counted). */
  function pendingWrites() {
    let names = [];
    try {
      names = fs
        .readdirSync(pendingDir)
        .filter((name) => /^[0-9a-f]{40}\.json$/.test(name))
        .sort();
    } catch {
      return [];
    }
    const out = [];
    let bad = 0;
    for (const name of names) {
      const file = path.join(pendingDir, name);
      try {
        const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof kept?.owner !== 'string' || (kept.op !== 'value' && kept.op !== 'lines')) {
          bad += 1;
          continue;
        }
        out.push({
          file,
          update:
            kept.op === 'value'
              ? { op: 'value', owner: kept.owner, value: kept.value }
              : { op: 'lines', owner: kept.owner, lines: Array.isArray(kept.lines) ? kept.lines : [] },
        });
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) log.error('memory db: pending unreadable', { count: bad });
    return out;
  }

  /**
   * Replays the pending writes through the writer (at the open), each file deleted once its write resolved.
   * Without a worker it runs synchronously and returns nothing; with one it returns the promise. Throws (rejects) with
   * `PENDING_REPLAY` when a write failed: its file stays.
   */
  function replayPending() {
    const writes = pendingWrites();
    if (writes.length === 0) return null;
    replaying = true;
    let failed = 0;
    let code = null;
    const done = (file) => {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* removed at the next replay */
      }
    };
    const fail = (error) => {
      failed += 1;
      code = codeOf(error);
    };
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
        try {
          applyMemoryWrite(handle, stampUnit(update));
          done(file);
        } catch (error) {
          fail(error);
        }
      }
      return finish();
    }
    return (async () => {
      for (const { file, update } of writes) {
        try {
          await engine.call('memoryWrite', { update: stampUnit(update) });
          done(file);
        } catch (error) {
          fail(error);
        }
      }
      finish();
    })();
  }

  /** One write on the writer connection: a message to the worker, or this thread's own connection. */
  function write(update) {
    if (!handle || closing)
      return Promise.reject(Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' }));
    if (engine) return engine.call('memoryWrite', { update });
    return Promise.resolve().then(() => applyMemoryWrite(handle, update));
  }

  /** What each open does once (schema v11): stale wake runs interrupted, the skills registered (each behind its switch). */
  function startupJobs() {
    const given = hot.config?.memoryDb ?? {};
    if (given.wakeRuns === true) {
      const budget = hot.config?.innerLife?.loop?.timeBudgetMs;
      write({
        kind: 'wake',
        op: 'interrupt',
        now: now(),
        limitMs: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_TURN_BUDGET_MS,
      })
        .then((done) => {
          if (done?.interrupted > 0) log.debug?.('memory db: wake runs interrupted', { runs: done.interrupted });
        })
        .catch((error) => log.warn('memory db: wake interrupt failed', { code: codeOf(error) }));
    }
    if (given.skillsRegistry === true) {
      Promise.resolve()
        .then(async () => {
          const [{ SKILL_DEFINITIONS }, { NESTED_CAPABILITIES }] = await Promise.all([
            import('../../tools/definitions.ts'),
            import('../../tools/access.ts'),
          ]);
          const sources = opSources();
          const entries = skillVersionsOf({
            definitions: SKILL_DEFINITIONS,
            nested: NESTED_CAPABILITIES,
            sourceOf: (op) => sources.get(op) ?? '',
            commit: typeof commit === 'string' ? commit : engineCommit(),
          });
          return write({ kind: 'skills', entries, now: now() });
        })
        .then((done) =>
          log.debug?.('memory db: skills registered', {
            skills: done?.skills ?? 0,
            versions: done?.versions ?? 0,
            stale: done?.stale ?? 0,
          })
        )
        .catch((error) => log.warn('memory db: skills registry failed', { code: codeOf(error) }));
    }
  }

  /**
   * One write of the inner life's wake runs (wakes.js#applyWakeWrite) through the writer, while `memoryDb.wakeRuns` is
   * exactly true and the database is open; else null (nothing is written).
   */
  function recordWake(update) {
    if (!handle || closing || hot.config?.memoryDb?.wakeRuns !== true || update?.kind !== 'wake') return null;
    return write(update);
  }

  /**
   * One observation of the live message path (observe.js#observe) through the writer: resolves the observe result
   * (`{ ok, ... }` or `{ ok: false, code }`) while the database is open, else null (the observation waits in the queue
   * below). A failed write is logged with a code and resolves null: never a turn's failure. `where`
   * (`{ guildId, privateUserId }`) names the record the line belongs to: the observation is the record of the line (its
   * record unit is passed to observe.js), and a write that failed (not a refusal) stays in the queue below and is tried
   * again at the next tick, up to OBSERVE_ATTEMPTS times (then dropped, a warning).
   */
  // Observations that came while the database was not open yet (the start's catch-up runs before it opens) wait here
  // and are written right after it opens; a shutdown writes the waiting ones and those under way before it closes.
  // Bounded: past OBSERVE_QUEUE_MAX the oldest is dropped. Every dropped observation is counted (`status().observe`):
  // the first drop of a run of drops is a warning at once, and the run's count is a warning when the queue is next
  // written (the open, a tick) or at the shutdown; what the shutdown could not write is counted the same way.
  const OBSERVE_QUEUE_MAX = 5000;
  const OBSERVE_ATTEMPTS = 5;
  const observeQueue = [];
  const observing = new Set();
  let observeDropped = 0;
  let observeShutdown = false;
  // The drops not yet reported by a count warning, by reason.
  const droppedUntold = new Map();

  /** One dropped observation, counted (see above). */
  function dropObservation(reason) {
    observeDropped += 1;
    const untold = droppedUntold.get(reason) ?? 0;
    droppedUntold.set(reason, untold + 1);
    if (untold === 0) log.warn('memory db: observe dropped', { reason, dropped: observeDropped });
  }

  /** The drops since the last count warning, one warning per reason with its count. */
  function tellDropped() {
    for (const [reason, count] of droppedUntold)
      log.warn('memory db: observations dropped', { reason, count, dropped: observeDropped });
    droppedUntold.clear();
  }
  const observeOn = (envelope) => envelope !== null && typeof envelope === 'object';

  /** The record unit of an observed line (record.js#dayFile's day: the UTC day of the line), or null. */
  function recordUnitOf(envelope, where) {
    const guildId = where?.guildId;
    const day = /^\d{4}-\d{2}-\d{2}/.exec(String(envelope?.occurredAt ?? ''))?.[0];
    if (typeof guildId !== 'string' || !guildId || !day) return null;
    const layer =
      typeof where.privateUserId === 'string' && where.privateUserId
        ? `guilds/${guildId}/private/${where.privateUserId}`
        : `guilds/${guildId}`;
    return `${layer}/record/${day.slice(0, 7)}/${day}.jsonl`;
  }

  /** Queues an observation (bounded: the oldest goes first, counted). */
  function queueObservation(item) {
    observeQueue.push(item);
    if (observeQueue.length > OBSERVE_QUEUE_MAX) {
      observeQueue.shift();
      dropObservation('queue_full');
    }
  }

  function sendObservation(item) {
    const { envelope, owner } = item;
    const done = (
      engine
        ? engine.call('observe', { envelope, now: now(), owner })
        : Promise.resolve().then(() => observeEnvelope(handle, envelope, { now, log, owner }))
    )
      .then((result) => {
        if (result && result.ok === false) log.warn('memory db: observe refused', { code: result.code ?? null });
        return result;
      })
      .catch((error) => {
        log.warn('memory db: observe failed', { code: codeOf(error) });
        // The observation is the line's only record: it waits for the next tick; past the shutdown's last write no tick
        // comes, so it is counted as dropped.
        if (observeShutdown) dropObservation('shutdown');
        else {
          const attempts = (item.attempts ?? 0) + 1;
          if (attempts < OBSERVE_ATTEMPTS) queueObservation({ ...item, attempts });
          else dropObservation('retries');
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
        dropObservation('closed');
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
    tellDropped();
    const waiting = observeQueue.splice(0, observeQueue.length);
    log.info('memory db: observations written after open', { count: waiting.length });
    for (const item of waiting) sendObservation(item);
  }

  /**
   * The waiting observations written and every one under way awaited (a retry that failed again waits for the next
   * round, at most OBSERVE_ATTEMPTS rounds): the queue as the next tick leaves it. Resolves the queue's size after.
   */
  async function waitObservations() {
    for (let round = 0; round < OBSERVE_ATTEMPTS && (observeQueue.length > 0 || observing.size > 0); round += 1) {
      drainObservations();
      await Promise.allSettled([...observing]);
      if (!handle) break;
    }
    return observeQueue.length;
  }

  /**
   * One write of a memory unit (unit-write.js) through the writer. Resolves the writer's counts once committed; rejects
   * with a code (`DB_CLOSED` while the database is not open).
   */
  async function writeUnit(update) {
    if (!handle || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    const stamped = stampUnit(update);
    if (engine) return engine.call('memoryWrite', { update: stamped });
    return applyMemoryWrite(handle, stamped);
  }

  // The graph projection a migration left pending and the stems of new lines: the writer finishes them, one slice per
  // tick (unit-write.js, op `project`).
  let projectRun = null;
  function startProject() {
    if (closing || !handle || projectRun || engine?.dead) return;
    let due = false;
    try {
      due = graphPending(handle) || stemsPending(handle.db);
    } catch {
      due = false;
    }
    if (!due) return;
    projectRun = writeUnit({ op: 'project', maxSlices: 1 })
      .then((done) => {
        if (done?.units > 0 || done?.stems > 0)
          log.debug?.('memory db: projected', { units: done.units, stems: done.stems, done: done.done });
      })
      .catch((error) => log.warn('memory db: projection failed', { code: codeOf(error) }))
      .finally(() => {
        projectRun = null;
      });
  }

  /**
   * Shutdown: the waiting observations are written, then every one under way is awaited. One that failed meanwhile (it
   * waits for a retry no tick will send) and one that fails from here on (the writer stopped under it) is lost with the
   * shutdown: counted as dropped (reason `shutdown`) and told with its count once the database is closed.
   */
  async function flushObservations(timeoutMs) {
    drainObservations();
    await waitFor(Promise.allSettled([...observing]), timeoutMs);
    observeShutdown = true;
    for (let n = observeQueue.length; n > 0; n -= 1) dropObservation('shutdown');
    observeQueue.length = 0;
  }

  /** The sources `ids` were read by a request or a session: touched (index-policy.js#touch) while eviction is on. */
  function touchSources(ids) {
    if (!handle || closing || !indexSettings(hot.config).eviction) return;
    const sources = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (sources.length === 0) return;
    write({
      kind: 'touch',
      sourceIds: sources,
      now: now(),
      config: { recall: { db: hot.config?.recall?.db ?? {} } },
    }).catch((error) => log.warn('memory db: touch failed', { code: codeOf(error) }));
  }

  // The index policy (index-policy.js): once per UTC day while `recall.db.vectorEviction` is on, through the writer.
  let indexRun = null;
  let indexDay = null;
  function startIndexPolicy() {
    if (closing || !handle || indexRun || engine?.dead) return;
    if (!indexSettings(hot.config).eviction) return;
    const at = now();
    const day = utcDay(at);
    if (indexDay === day) return;
    indexRun = write({ kind: 'index-policy', now: at, config: { recall: { db: hot.config?.recall?.db ?? {} } } })
      .then((done) => {
        indexDay = day;
        log.debug?.('memory db: index policy', {
          a: done?.tiers?.a ?? 0,
          b: done?.tiers?.b ?? 0,
          c: done?.tiers?.c ?? 0,
          evicted: done?.evicted ?? 0,
        });
      })
      .catch((error) => log.warn('memory db: index policy failed', { code: codeOf(error) }))
      .finally(() => {
        indexRun = null;
      });
  }

  // The re-embed job (index-policy.js#reembedTouched): `recall.db.reembed` with an embedding client, at most once a minute.
  let reembedRun = null;
  let reembedAt = -Infinity;
  function startReembed() {
    if (closing || !handle || reembedRun || engine?.dead || typeof embed !== 'function') return;
    if (!indexSettings(hot.config).reembed) return;
    const at = now();
    if (at - reembedAt < REEMBED_EVERY_MS) return;
    reembedAt = at;
    const db = handle.db;
    reembedRun = (async () => {
      const [{ quantize }, { recordChunk }, { roleModel }] = await Promise.all([
        import('../vectors.js'),
        import('../chunks.js'),
        import('../../llm/roles.js'),
      ]);
      const config = hot.config;
      const nameOf = (id) => {
        try {
          const names = JSON.parse(
            db.prepare('SELECT names FROM accounts WHERE native_id = ? LIMIT 1').get(id)?.names ?? 'null'
          );
          return Array.isArray(names) && typeof names[0] === 'string' ? names[0] : null;
        } catch {
          return null;
        }
      };
      return reembedTouched({
        db,
        write,
        embed,
        config,
        now: at,
        quantize,
        model: roleModel(config, 'embedding') ?? null,
        chunkOf: (line, context) => recordChunk(line, context, { nameOf, selfName: selfName() ?? '' }).text,
      });
    })()
      .then((done) => {
        if (done.pending > 0)
          log.debug?.('memory db: reembed', {
            pending: done.pending,
            embedded: done.embedded,
            written: done.written,
            skipped: done.skipped,
          });
      })
      .catch((error) => log.warn('memory db: reembed failed', { code: codeOf(error) }))
      .finally(() => {
        reembedRun = null;
      });
  }

  // The focus job (focus.js): once per UTC day, through the writer, with the live settings.
  let focusRun = null;
  let focusDay = null;
  function startFocus() {
    if (closing || !handle || focusRun || engine?.dead) return;
    if (hot.config?.memoryDb?.focus?.enabled !== true) return;
    const at = now();
    const day = utcDay(at);
    if (focusDay === day) return;
    try {
      if (lastFocusDay(handle.db) === day) {
        focusDay = day;
        return;
      }
    } catch {
      /* a database before v10: the job runs and fails with a code */
    }
    const config = { focus: hot.config?.focus ?? null };
    const job = engine
      ? engine.call('focus', { now: at, config })
      : Promise.resolve().then(() => runFocusDay(handle, { now: at, config }));
    focusRun = job
      .then((done) => {
        focusDay = day;
        log.debug?.('memory db: focus', {
          days: done.days,
          rows: done.rows,
          close: done.close,
          exploring: done.exploring,
          events: done.events,
        });
      })
      .catch((error) => log.warn('memory db: focus failed', { code: codeOf(error) }))
      .finally(() => {
        focusRun = null;
      });
  }

  /**
   * The focus sets for the heartbeat's people view (focus.js#focusView, an internal read): `{ close, exploring,
   * exploringShare }` as member ids of the interface, each the best scored first; null while the database is closed.
   */
  function focusPeople({ iface = LEGACY_IFACE } = {}) {
    if (!handle) return null;
    try {
      const sets = focusView(handle.db, { iface });
      const share = hot.config?.focus?.exploringShare;
      return { ...sets, exploringShare: Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.15 };
    } catch (error) {
      log.warn('memory db: focus read failed', { code: codeOf(error) });
      return null;
    }
  }

  // The daily backup through the writer (see the head of this file).
  let backupRun = null;
  const backupState = { doneDay: null, lastAt: null, lastName: null, lastFailure: null, failedAt: null, toldDay: null };

  /** One failed backup: a warning, the status, and her fact once per UTC day. */
  function backupFailed(code, at) {
    backupState.lastFailure = { code, at };
    backupState.failedAt = at;
    log.warn('memory db: backup failed', { code });
    const day = utcDay(at);
    if (backupState.toldDay === day || typeof onBackupFailure !== 'function') return;
    backupState.toldDay = day;
    try {
      onBackupFailure({ code, at });
    } catch (error) {
      log.warn('memory db: the backup failure could not be told', { code: codeOf(error) });
    }
  }

  /** The tick's look: a backup when one is due today, never two at once. */
  function startBackup() {
    if (closing || !handle || backupRun || engine?.dead) return;
    if (hot.config?.memoryDb?.backup?.enabled !== true) return;
    const at = now();
    const day = utcDay(at);
    if (backupState.doneDay === day) return;
    const { hour, dir, keep } = backupSettings(hot.config, dataDir);
    if (new Date(at).getUTCHours() < hour) return;
    if (
      backupState.failedAt !== null &&
      utcDay(backupState.failedAt) === day &&
      at - backupState.failedAt < BACKUP_RETRY_MS
    )
      return;
    let done = null;
    try {
      done = backupOn(dir, day);
    } catch {
      done = null;
    }
    if (done) {
      backupState.doneDay = day;
      return;
    }
    const name = backupName(at);
    const partial = path.join(dir, partialOf(name));
    backupRun = (async () => {
      try {
        fs.rmSync(partial, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const update = {
          kind: 'backup',
          to: partial,
          dataDir,
          now: at,
          commit: typeof commit === 'string' ? commit : engineCommit(),
          configHash: configHash(hot.config),
        };
        const manifest = await write(update);
        fs.renameSync(partial, path.join(dir, name));
        backupState.doneDay = day;
        backupState.lastAt = at;
        backupState.lastName = name;
        backupState.lastFailure = null;
        backupState.failedAt = null;
        let removed = 0;
        try {
          removed = pruneBackups(dir, keep);
        } catch (error) {
          log.warn('memory db: backup prune failed', { code: codeOf(error) });
        }
        log.info('memory db: backup', {
          files: manifest?.files?.length ?? 0,
          tables: Object.keys(manifest?.rows ?? {}).length,
          removed,
        });
      } catch (error) {
        try {
          fs.rmSync(partial, { recursive: true, force: true });
        } catch {
          /* removed at the next prune */
        }
        backupFailed(codeOf(error), at);
      }
    })().finally(() => {
      backupRun = null;
    });
  }

  // The effective models and her memory session's schedule (see the head of this file).
  let modelsLogged = false;
  let sessionRun = null;
  let sessionLookAt = -Infinity;
  const sessionState = {
    lastAt: null,
    lastOutcome: null,
    lastFailure: null,
    told: new Set(),
    reviewFailDay: null,
    reviewFails: 0,
    reviewSkip: new Set(),
  };
  const SESSION_FAILURES = new Set([
    'llm_error',
    'bad_answer',
    'build_error',
    'write_failed',
    'not_configured',
    'skipped',
  ]);

  /** The start-up line of the effective models (codes and model ids only, never a key value). */
  function logEffectiveModels() {
    if (modelsLogged) return Promise.resolve();
    modelsLogged = true;
    return import('./writer-switch.js')
      .then(({ effectiveModels, effectiveModelsLine }) =>
        log.info('memory db: effective models', {
          purposes: effectiveModelsLine(effectiveModels(hot.config, sessionEnv?.() ?? null)),
        })
      )
      .catch((error) => log.warn('memory db: effective models failed', { code: codeOf(error) }));
  }

  /** One failing scope told once (`onSessionFailure`) until it runs fine again. */
  function sessionFailed(run, at) {
    const code = run.outcome;
    sessionState.lastFailure = { code, at, scope: String(run.scope ?? '').split(':')[0] || null };
    log.warn('memory session: run failed', { code, scope: sessionState.lastFailure.scope, lines: run.lines ?? 0 });
    if (sessionState.told.has(run.scope)) return;
    sessionState.told.add(run.scope);
    if (typeof onSessionFailure !== 'function') return;
    const [scopeKind, iface, ...rest] = String(run.scope ?? '').split(':');
    try {
      onSessionFailure({
        scopeKey: run.scope,
        scopeKind,
        iface: iface ?? null,
        partner: scopeKind === 'dm' ? rest.join(':') || null : null,
        code,
        lines: run.lines ?? 0,
        at,
      });
    } catch (error) {
      log.warn('memory session: the failure could not be told', { code: codeOf(error) });
    }
  }

  /** One scheduled look: a sweep over the due scopes, then the reviews her flags ask for. Never throws. */
  async function sessionJob(at) {
    const [
      { sweep, refusalOf, sessionSettings },
      { reviewDescription, reviewRefusal },
      { dueScopes, openFlags, reviewsToday },
    ] = await Promise.all([import('./session.js'), import('./describe.js'), import('./writer-switch.js')]);
    const config = hot.config;
    const env = sessionEnv?.() ?? null;
    const llm = sessionLlm?.() ?? null;
    if (!llm || !handle || refusalOf(config, env, hot.prompts)) return;
    const db = handle.db;
    const ctx = {
      db,
      write: memoryWrite,
      llm,
      hot,
      env,
      now,
      log,
      selfName: selfName() ?? '',
    };
    const due = dueScopes(db, config, at);
    if (due.length > 0) {
      const result = await sweep(ctx, { scopes: new Set(due.map((scope) => scope.key)) });
      sessionState.lastAt = at;
      sessionState.lastOutcome = result.status === 'ok' ? 'ok' : (result.code ?? result.status);
      for (const run of result.runs ?? []) {
        if (SESSION_FAILURES.has(run.outcome)) sessionFailed(run, at);
        else if (run.outcome === 'ok' || run.outcome === 'applied_before') sessionState.told.delete(run.scope);
      }
      log.debug?.('memory session: sweep', {
        scopes: due.length,
        runs: result.runs?.length ?? 0,
        status: result.status,
      });
    }
    // The reviews: at most `reviewsPerDay` a UTC day, accepted or failed.
    if (closing || !handle || reviewRefusal(config, env, hot.prompts)) return;
    const day = utcDay(at);
    if (sessionState.reviewFailDay !== day) {
      sessionState.reviewFailDay = day;
      sessionState.reviewFails = 0;
      sessionState.reviewSkip = new Set();
    }
    let left = sessionSettings(config).reviewsPerDay - reviewsToday(db, at) - sessionState.reviewFails;
    if (left <= 0) return;
    for (const flag of openFlags(db, config, { skip: sessionState.reviewSkip, selfName: ctx.selfName })) {
      if (left <= 0 || closing || !handle) break;
      left -= 1;
      const reviewed = await reviewDescription(db, flag.subject, flag.field, {
        ctx: { ...ctx, readCtx: flag.readCtx },
      });
      if (reviewed.status === 'ok') continue;
      sessionState.reviewFails += 1;
      sessionState.reviewSkip.add(flag.key);
      sessionState.lastFailure = {
        code: reviewed.code ?? reviewed.status,
        at,
        scope: flag.readCtx?.kind ?? null,
        review: true,
      };
      log.warn('memory session: review failed', {
        code: reviewed.code ?? reviewed.status,
        step: reviewed.step ?? null,
        kind: flag.subject.kind,
      });
    }
  }

  /** The schedule's tick: at most one look a `sessionLookMs`, never two at once. */
  function startSession() {
    if (closing || !handle || sessionRun || engine?.dead) return;
    if (hot.config?.memoryDb?.session?.mode !== 'apply') return;
    const at = now();
    if (at - sessionLookAt < sessionLookMs) return;
    sessionLookAt = at;
    sessionRun = sessionJob(at)
      .catch((error) => {
        sessionState.lastFailure = { code: codeOf(error), at, scope: null };
        log.warn('memory session: run failed', { code: codeOf(error), scope: null });
      })
      .finally(() => {
        sessionRun = null;
      });
  }

  /** The read-only connection (`{ db }`) while the database is open, else null. */
  const readHandle = () => (handle !== null && !closed && !replaying ? handle : null);

  /** The tick: opens the database when it is not open, then runs the jobs that are due. Safe to call at any rate. */
  async function tick() {
    if (closing) return;
    if (engine?.dead) await closeNow(0);
    if (!handle) {
      // On the calling thread the open is synchronous; only the worker's open is waited for.
      const opening = openNow();
      if (threaded) await opening;
    }
    if (!handle) return;
    drainObservations();
    startProject();
    startDiaryMedia();
    startFocus();
    startIndexPolicy();
    startReembed();
    startSession();
    startBackup();
  }

  /** The database for recall (src/memory/db/recall.js): the read-only connection while it is open, else null. */
  const database = () => (handle !== null && !replaying ? handle.db : null);

  /**
   * The memory a turn's request carried (prompt.js `memoryReads`), written as turn_reads rows of its step, deferred.
   * `contextId` is the execution context of the read (`issueContext`), `readerKind` `turn` (default), `session` or `wake`.
   * @param {{ turnId: string, step?: string, guildId?: string|null, reads: { kind: string, id: string }[], contextId?: string|null, readerKind?: string }} args
   */
  function recordTurnReads({
    turnId,
    step = 's0',
    guildId = null,
    reads: carried,
    contextId = null,
    readerKind = 'turn',
  }) {
    if (!handle || !settings().turnReads || !turnId || !Array.isArray(carried) || carried.length === 0) return;
    // Resolved now, from the rows as they are when the request is assembled; only the write waits for a quiet loop.
    let rows;
    try {
      rows = turnReadRows(handle.db, carried, { guildId, iface: liveIface(iface) ?? LEGACY_IFACE });
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

  // Her session's attitude moves, told to whoever caches the people they move (the store: a profile it holds would
  // otherwise write its older score over the move at its next flush). Each committed move is told once, after its
  // apply, also when the apply's answer was lost (the move is read back from the database by its run).
  const affinityListeners = new Set();
  const toldMoves = new Set();
  const TOLD_MOVES_KEPT = 10_000;

  /** Subscribes `fn(moves)` (`[{ personId, applied, score }]`) to her session's committed attitude moves; returns the unsubscribe. */
  function onAffinityMoves(fn) {
    if (typeof fn !== 'function') return () => {};
    affinityListeners.add(fn);
    return () => affinityListeners.delete(fn);
  }

  /** The committed attitude moves of run `runId` not told yet, told to every listener (a failure is a warning, never the write's). */
  function tellAffinityMoves(runId) {
    if (affinityListeners.size === 0 || typeof runId !== 'string' || !runId || !handle) return;
    let moves = [];
    try {
      const prefix = `aff:${runId}:`;
      moves = handle.db
        .prepare(
          'SELECT id, person_id AS personId, applied, score FROM affinity_events WHERE substr(id, 1, ?) = ? ORDER BY id'
        )
        .all(prefix.length, prefix)
        .filter((move) => !toldMoves.has(move.id));
    } catch (error) {
      log.warn('memory db: affinity moves unread', { code: codeOf(error) });
      return;
    }
    if (moves.length === 0) return;
    for (const move of moves) {
      toldMoves.add(move.id);
      if (toldMoves.size > TOLD_MOVES_KEPT) toldMoves.delete(toldMoves.values().next().value);
    }
    const told = moves.map(({ personId, applied, score }) => ({ personId, applied, score }));
    for (const fn of affinityListeners) {
      try {
        fn(told);
      } catch (error) {
        log.warn('memory db: affinity moves not told', { code: codeOf(error) });
      }
    }
  }

  /**
   * One write of her memory session or a description review (session-write.js), on the writer connection: a message
   * to the worker, or the calling thread's own connection when there is no worker. Rejects when the database is closed.
   * A session's apply then tells its attitude moves (`onAffinityMoves`), whether its answer came back or not.
   */
  async function memoryWrite(update) {
    if (!handle || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    // The read predicate of the target check is the live config's; a diary entry's media go under the data directory.
    const stamped = { ...update, audienceColumn: hot.config?.memoryDb?.audienceColumn === true, dataDir };
    // A session's batch read its lines: touched while eviction is on.
    if (update?.kind === 'session' && Array.isArray(update.reads))
      touchSources(update.reads.filter((row) => row?.row_kind === 'sources').map((row) => row.row_id));
    const applies = update?.kind === 'session' && update.mode === 'apply';
    try {
      if (engine) return await engine.call('memoryWrite', { update: stamped });
      return applyMemoryWrite(handle, stamped);
    } finally {
      if (applies) tellAffinityMoves(update.run?.id);
    }
  }

  /**
   * Issues an execution context for one turn, session or wake (scope.ts#issueContext), read through `audience_id` when
   * `memoryDb.audienceColumn` is on. While the database is open the context is recorded in `execution_contexts`,
   * deferred through the writer (a failure is logged with a code); otherwise it is only the object.
   * @param {{ kind: 'group'|'dm'|'internal', iface?: string, person?: string, place?: string|null, destination?: string|null }} spec
   */
  function issueContext(spec = {}) {
    const ctx = issuePureContext({ ...spec, now, audienceColumn: hot.config?.memoryDb?.audienceColumn === true });
    if (!handle || closing) return ctx;
    const update = { kind: 'context', context: contextRow(ctx) };
    defer(() => {
      if (!handle || closing) return;
      const done = engine
        ? engine.dead
          ? null
          : engine.call('memoryWrite', { update })
        : Promise.resolve().then(() => applyMemoryWrite(handle, update));
      done?.catch((error) => log.warn('memory db: context record failed', { code: codeOf(error) }));
    });
    return ctx;
  }

  /** The state for the status card: whether it is open, its units and rows, the backup, the observations, her session. */
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
      } catch {
        /* a closing database */
      }
    }
    return {
      open,
      openedAt,
      files,
      rows,
      backup: {
        running: backupRun !== null,
        lastAt: backupState.lastAt,
        lastName: backupState.lastName,
        lastFailure: backupState.lastFailure,
      },
      observe: { queued: observeQueue.length, writing: observing.size, dropped: observeDropped },
      session: {
        running: sessionRun !== null,
        lastAt: sessionState.lastAt,
        lastOutcome: sessionState.lastOutcome,
        lastFailure: sessionState.lastFailure,
        reviewsFailedToday: sessionState.reviewFailDay === utcDay(now()) ? sessionState.reviewFails : 0,
      },
    };
  }

  /** Shutdown: waits for the jobs under way, writes what waits, closes the database, releases the lock. */
  async function close() {
    closing = true;
    const { closeMs } = settings();
    const deadline = performance.now() + closeMs;
    await waitFor(diaryJob.stop(), closeMs);
    await waitFor(focusRun, Math.max(0, deadline - performance.now()));
    await waitFor(indexRun, Math.max(0, deadline - performance.now()));
    await waitFor(reembedRun, Math.max(0, deadline - performance.now()));
    await waitFor(projectRun, Math.max(0, deadline - performance.now()));
    await waitFor(sessionRun, Math.max(0, deadline - performance.now()));
    await waitFor(backupRun, Math.max(0, deadline - performance.now()));
    await flushTurnReads(Math.max(0, deadline - performance.now()));
    await flushObservations(Math.max(0, deadline - performance.now()));
    await closeNow(Math.max(0, deadline - performance.now()));
    await Promise.allSettled([...observing]);
    tellDropped();
    closed = true;
  }

  /** The scheduled session look under way, or a resolved promise: its end. */
  const waitSession = () => sessionRun ?? Promise.resolve();
  /** The daily backup under way, or a resolved promise: its end. */
  const waitBackup = () => backupRun ?? Promise.resolve();

  return {
    tick,
    database,
    readHandle,
    recordTurnReads,
    memoryWrite,
    onAffinityMoves,
    writeUnit,
    keepPending,
    recordWake,
    issueContext,
    observe,
    waitObservations,
    focusPeople,
    status,
    close,
    waitSession,
    waitBackup,
  };
}
