// The memory database inside the bot (spec 2026-10-24-memory-store, sections 5, 7 and 10): the one memory.
//
// `createMemoryDb({ hot, dataDir, log, now })` opens `data/<memoryDb.file>` with the writer lock and keeps it open while
// the bot runs; every memory module reads it and writes it through this service:
//   - `open()` closes interrupted request records and replays pending writes before exposing readers. Core startup awaits it before
//     constructing durable stores. It runs no maintenance jobs. `tick()` retries a refused open (logged once per code)
//     and runs maintenance after the core is constructed.
//   - `readHandle()` is the read-only connection while the database is open (null otherwise): what the memory modules'
//     readers read through (src/memory/db/readers/), and `database()` its raw connection for recall
//     (src/memory/db/recall.ts).
//   - `recordTurnReads` resolves the memory rows one step's request carried when it is called, at assembly time, on the
//     read connection (the block each was in, its order, the exact claim / description version and source revision),
//     and writes the turn_reads rows deferred, one transaction. The persistence is deferred; the
//     resolution is not, so a later write cannot change which version a turn is said to have read.
//   - `searchRecord(input, { signal })` is a search of the record (recall.ts#search) on the reader thread
//     (reader-client.ts, reader-worker.ts), with the result the synchronous call gives. It rejects with a code:
//     `SEARCH_ABANDONED` (the signal aborted: the reader is restarted, the searches behind it are still answered),
//     `WORKER_EXIT` (the reader died under it; the next search starts a new one) or `DB_CLOSED`. Without a worker it
//     runs on this thread's connection.
//   - `memoryWrite` is the one way her memory session and the description review write (session-write.ts): a message to
//     the worker, so the bot's loop never holds a write transaction. The service stamps `audienceColumn` (the target check
//     reads through `audience_id`) into every write. After an apply, its committed attitude moves are told
//     once to the subscribers of `onAffinityMoves(fn)` (the store's unit cache, src/memory/unit-cache.ts, whose cached
//     profiles would otherwise write an older score over them).
//   - `status().observe` counts the observations waiting for the database (`queued`), under way (`writing`) and lost
//     (`dropped`: the bounded queue's oldest, a write that failed every retry, one the shutdown could not write);
//     `waitObservations()` writes the waiting ones and awaits them.
//   - the task board (src/board/writer.ts) writes through `memoryWrite` too: an agent's `task.*` command, a board call
//     of her tools and the reaper's beat are each a write of kind `board`, run by the writer whole.
//   - `issueContext(spec)` issues an execution context (scope.ts#issueContext: an id, the mode, the destination) read
//     through `audience_id`, and records it in `execution_contexts`
//     (deferred, through the writer) while the database is open; closed, the context is a pure object all the same.
//     `recordTurnReads` stores the context id (`contextId`, '' without one) and the reader kind (`turn` by default).
//   - the focus job (schema v10, focus.ts): once per UTC day, at a tick, the
//     relationship counts of yesterday and today are recounted and the close and exploring sets recomputed, through the
//     writer (the worker), with the live `focus` settings. `focusPeople()` reads the sets for the heartbeat's people
//     view on the read connection (an internal reader), with `focus.exploringShare`; null while the database is closed.
//   - schema v11 (wakes.ts, index-policy.ts):
//       the wake runs: `recordWake(update)` is the inner life's one way to write its wake runs (src/behavior/
//       inner.ts), through the writer; at each open the runs a dead process left `running` longer than the inner
//       turn's time budget (`wakes.loop.timeBudgetMs`) become `interrupted`.
//       the skills registry (skills.ts, schema v22): its writes are `{ kind: 'skills', op, ... }` through the writer.
//       `recall.db.vectorEviction`: once per UTC day, at a tick, the index policy classifies every line and evicts
//       the vectors outside the owner's classes, through the writer; the sources a turn's request carried
//       (`recordTurnReads`) and a memory session's batch read (`memoryWrite`) are touched, so their vectors come back.
//       `recall.db.reembed` (with an injected `embed`, the embedding client): at most once a minute, at a tick, the
//       touched lines' evicted vectors are embedded again (index-policy.ts#reembedTouched) on this thread, and written
//       through the writer.
//   - `observe(envelope, where)`: one observation of the live message path (observe.ts#observe, the envelope from
//     observe-event.ts#observationOf) through the writer, like every other write: the observation is the record of the
//     line (`where` names its layer). Never throws.
//   - `writeUnit(update)` (unit-write.ts): the database writers of the memory units (record and journal lines, the
//     store's cache, the module stores, participation, the selfreflection, the vectors) through the writer; resolves once the
//     worker committed, rejects with a code (`DB_CLOSED` while the database is not open). Each tick also finishes the
//     graph projection and the stems a migration left (one slice a tick). The opener's migration context is the live
//     `selfreflection.placeId`'s place (the seed of schema v12's and v15's data steps); a selfreflection write's destination is the
//     place of the selfreflection's first enabled mirror. The durable intent of a write that failed (spec
//     2026-10-24-memory-authority, section 6 item 3): `keepPending(update)` (at shutdown, from unit-outbox.ts#keep)
//     writes it to `data/memory-pending/<sha1 of the owner>.json` (`{ owner, op, value | lines, at }`; the lines of one
//     owner are appended to what its file holds), and every open replays each pending file through the writer before
//     anything reads the database (`readHandle()` answers nothing meanwhile), deleting a file only after its write
//     resolved. A write whose replay fails moves to `memory-pending-quarantine/` with its code (pending-quarantine.ts),
//     the open goes on, an error line `memory db: pending quarantined` names the count and the code, and
//     `onPendingQuarantined({ count, code: 'memory-pending-quarantined', cause })` tells the core once per open.
//     `status().pending` counts what the quarantine holds; `quarantinedPending()` lists it and
//     `replayQuarantinedPending()` replays it through the writer (the owner's `/memory pending`). A write that cannot
//     be moved keeps its file, logs `memory db: pending replay failed` and fails the open (`PENDING_REPLAY`).
//   - `writeOperational(write)` (operational.ts): the engine's own state, usage, metrics, inner state, missed
//     registries, emoji rails and recall trace lines, by kind and subject, through the writer.
//   - `writeIntentions(write)` (intentions-write.ts): her list of intentions and the records moved to its archive.
//   - her memory session is the memory writer (spec 2026-10-24-memory-authority, section 6 item 7). Each open logs the
//     effective models (`memory db: effective models`: purpose, model id and key variable of the memory session, the
//     description review and every other purpose; writer-switch.ts#effectiveModels). With `memoryDb.session.mode`
//     `apply`, an LLM client (`sessionLlm`) and the key of the memory role (`sessionEnv`), a tick looks at most once a
//     minute for due scopes (writer-switch.ts#dueScopes: `minMessages` settled lines and `everyMinutes` since the
//     scope's last run or `maxMessages` waiting, under the per-scope daily cap) and runs one sweep over them
//     (session.ts#sweep), then the description reviews her flags ask for (writer-switch.ts#openFlags, at most
//     `memoryDb.session.reviewsPerDay` accepted or failed a UTC day; describe.ts#reviewDescription). Never two at once;
//     every write through the writer. A run that fails (`llm_error`, `bad_answer`, `build_error`, `write_failed`,
//     `not_configured`, `skipped`) is a warning (`memory session: run failed`, the code and the scope kind), the
//     status's `session.lastFailure`, and one `onSessionFailure({ scopeKey, scopeKind, iface, place, code, lines, at })`
//     per failing scope, with the kind, interface and DM place the run names, until that scope runs fine again (src/index.ts tells her: a `memoryFailed` fact); a failed review
//     is a warning and the status's `session.lastFailure`, and its flag waits for the next day.
//   - `inspection()` is the owner's port of snapshots over read-only connections of their own (inspection-snapshots.ts), null
//     while the database is closed. Each tick closes the expired ones, and a close of the database ends them all.
//   - `close()` ends the reader first (a read-only connection closing last would leave the WAL behind), waits for the
//     jobs under way, writes the turn reads and the observations still waiting, closes the database and releases the
//     lock. The waits are bounded by `memoryDb.closeTimeoutMs` (default 10000); then the
//     worker is terminated.
//
// Threads. By default the writer connection, the lock and every write live in a worker thread (writer-worker.ts); the
// main thread keeps a read-only connection, which is all the readers and the status card need (WAL: readers never wait
// for the writer). turn_reads go to the worker as messages rather than being written from the main thread: a second
// writer would wait out the worker's write transaction (up to the busy timeout) on the bot's own loop. A worker that
// exits or crashes is logged with a code, its calls fail, and the next tick opens a new one (the dead one's lock is
// ours to take over). The main thread never runs a mapper. Injecting `open` (the tests), or `worker: false`, keeps
// everything on the calling thread.
// Counts and codes only in the logs, never a path, a name or a text.

import type { MemoryPath } from '../../subharness/memory-path.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { keyText, placeCollection } from './storage-keys.ts';
import {
  QUARANTINE_DIR,
  quarantinePending,
  quarantineStatus,
  quarantinedIn,
  readPendingWrite,
  releaseQuarantined,
  writeError,
} from './pending-quarantine.ts';
import type { QuarantinedPending, QuarantineStatus } from './pending-quarantine.ts';
import type { StorageKey } from './storage-keys.ts';
import type { IntentionsWrite } from './intentions-write.ts';
import type { OperationalWrite } from './operational.ts';

import { lockPathOf, openMemoryDb } from './open.ts';
import { channelPlaceId, nativeAuthorityOf } from './ids.ts';
import { LEGACY_IFACE, liveIface, withLiveIface } from './legacy-namespace.ts';
import { contextRow, issueContext as issuePureContext } from './scope.ts';
import { linkedDmScopes } from './person-links.ts';
import { createInspectionPort } from './inspection-snapshots.ts';
import type { InspectionPort } from './inspection-snapshots.ts';
import { privateByPerson, privateByPlace } from './private-read.ts';
import { recallSettings } from '../../behavior/recall.ts';
import { retrieveMemory } from './retrieve.ts';
import type { RetrieveDeps } from './retrieve.ts';
import { dbSettings } from './recall.ts';
import { embedSemanticDocuments } from './semantic-search.ts';
import type { MemoryPage, MemoryQuery, RetrievalBounds } from './semantic-types.ts';
import { memoryQueryFor, retrievalBounds } from '../retrieval-input.ts';
import type { RetrievalInput } from '../retrieval-input.ts';
import type { PrivatePersonView, PrivatePlaceView } from './private-read.ts';
import { recoverRequestArchive } from './request-archive.ts';
import { isLegacySelfreflectionFile } from '../migration/paths.ts';
import { applySelfreflectionUpdate, createSelfreflectionMedia } from './selfreflection-media.ts';
import { embedMedia } from './media-store.ts';
import { embedObjects } from './object-vectors.ts';
import { NEWEST_CLAIM_VERSION_SQL, applyMemoryWrite, writeTurnReadRows } from './session-write.ts';
import { FOCUS_DEFAULTS, focusView, lastFocusDay, runFocusDay } from './focus.ts';
import { utcDay } from '../../time.ts';
import { indexSettings, reembedTouched } from './index-policy.ts';
import {
  deleteMessage as deleteMessageEnvelope,
  observeMessage as observeMessageEnvelope,
} from './message-families.ts';
import { observe as observeEnvelope } from './observe.ts';
import { channelPlaceOf } from './observe-event.ts';
import { graphPending } from './graph.ts';
import { stemsPending } from './stems.ts';
import { createReaderClient, SEARCH_ABANDONED, type ReaderClient } from './reader-client.ts';
import { search } from './recall.ts';
import type { SearchInput, SearchResult } from './recall.ts';
import { mirrorPlaces, readMirrors } from './mirrors.ts';
import { noteSkipped } from '../../board/errands.ts';
import { CODE } from '../../tools/codes.ts';
import type { Config, Db, Log, MemoryHandle, Row } from './types.ts';
import type { SessionContext } from './session.ts';
import { bindAccount, type BindConfirm, type BindInput, type BindResult } from './person-bind.ts';
import type { Track } from '../../loop-watch.ts';
import { untracked } from '../../loop-watch.ts';
import type { KeyRing } from '../../keys/ring.ts';
import { dbOf, asText, isFiniteNumber } from './types.ts';
import type { Context } from './scope.ts';

/** The folder of the unit writes that failed at a shutdown (stage W2b), under the data directory. */
export const PENDING_DIR = 'memory-pending';

const DEFAULT_FILE = 'memory.db';
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
/** The inner turn's time budget when `wakes.loop.timeBudgetMs` is not set (config.json's value). */
const DEFAULT_TURN_BUDGET_MS = 180_000;
/** The least time between two runs of the re-embed job. */
const REEMBED_EVERY_MS = 60_000;
const ENGINE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The engine's commit (`git rev-parse HEAD` in the checkout), or 'unknown'. */
export function engineCommit(cwd = ENGINE_ROOT): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}
const WORKER_FILE = new URL('./writer-worker.ts', import.meta.url);
const READER_FILE = new URL('./reader-worker.ts', import.meta.url);
const noop = () => {};
const silent: Log = { info: noop, warn: noop, error: noop, debug: noop };

/** The kinds of read that name their row by its id, and the table each row is in. */
const DIRECT_READS: Readonly<Record<string, string>> = Object.freeze({
  claim: 'claims',
  claim_version: 'claim_versions',
  episode: 'episodes',
  participation: 'episodes',
  recent_line: 'claims',
  source_id: 'sources',
  description: 'descriptions',
  place: 'places',
  intention: 'intentions',
});

/** What a read of a row showed: a claim's newest version, a description's current one, the exact version it names, a source's revision. */
function readVersions(db: Db): (rowKind: string, rowId: string) => { version_id: unknown; revision: unknown } {
  const claimVersion = db.prepare(NEWEST_CLAIM_VERSION_SQL);
  const descriptionVersion = db.prepare('SELECT current_version AS id FROM descriptions WHERE id = ?');
  const sourceRevision = db.prepare('SELECT revision FROM sources WHERE id = ?');
  return (rowKind, rowId) => {
    const shown = { version_id: null as unknown, revision: null as unknown };
    if (rowKind === 'claims') shown.version_id = claimVersion.get(rowId)?.id ?? null;
    else if (rowKind === 'descriptions') shown.version_id = descriptionVersion.get(rowId)?.id ?? null;
    else if (rowKind === 'claim_versions') shown.version_id = rowId;
    else if (rowKind === 'sources') shown.revision = sourceRevision.get(rowId)?.revision ?? null;
    return shown;
  };
}

/**
 * The turn_reads rows of one `memoryReads` list (prompt.js#buildRequest), resolved against the database now:
 * `{ row_kind, row_id, block, ord, version_id, revision }`. `block` and `ord` are the block the read sat in and its place
 * in the request; `version_id` is the newest claim version or the current description version; `revision` a source's.
 * Besides the kinds her turns name, a read may name a row by its database id (her memory session's request does):
 * `source_id`, `description`, `place`, `intention`, and `claim_version`, one exact version with its own id as `version_id`.
 */
export function turnReadRows(
  db: Db,
  reads: unknown,
  { placeId = null, iface = LEGACY_IFACE }: { placeId?: string | null; iface?: string } = {}
): Array<Row> {
  const authority = nativeAuthorityOf(iface);
  const rows = new Map<string, Row>();
  const versionOfRead = readVersions(db);
  let at = 0;
  const put = (rowKind: string, rowId: unknown, read: Row): void => {
    if (typeof rowId !== 'string' || !rowId) return;
    const key = `${rowKind}\u0000${rowId}`;
    if (rows.has(key)) return;
    rows.set(key, {
      row_kind: rowKind,
      row_id: rowId,
      block: typeof read.block === 'string' ? read.block : null,
      ord: Number.isInteger(read.ord) ? read.ord : at,
      ...versionOfRead(rowKind, rowId),
    });
  };
  const hasRow = (table: string, id: string): boolean =>
    db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE id = ? LIMIT 1`).get(id) !== undefined;
  // A message id is native to one authority: the turn's interface, never matched alone.
  const latestMessage = db.prepare(
    "SELECT id FROM sources WHERE native_id = ? AND authority_id IS ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1"
  );
  // A null entry has no id, so the check below skips it.
  for (const read of (Array.isArray(reads) ? reads : []) as Array<Row>) {
    at += 1;
    const id = read?.id === undefined || read?.id === null ? '' : asText(read.id);
    if (!id) continue;
    const direct = DIRECT_READS[asText(read.kind)];
    if (direct !== undefined) put(direct, id, read);
    else if (read.kind === 'lore') put('claims', `lore:${id}`, read);
    else if (read.kind === 'channel') put('places', channelPlaceOf(db, authority, id), read);
    else if (read.kind === 'place_note' && placeId) put('descriptions', `desc:${placeId}:${id}`, read);
    else if (read.kind === 'item' && hasRow('claims', id)) put('claims', id, read);
    else if (read.kind === 'item' && hasRow('episodes', id)) put('episodes', id, read);
    else if (read.kind === 'source') put('sources', latestMessage.get(id, authority)?.id, read);
  }
  return [...rows.values()];
}

/** The reader kinds of `turn_reads`. */
export const READER_KINDS: ReadonlyArray<string> = Object.freeze(['turn', 'session', 'wake']);

/**
 * Writes resolved turn_reads rows (`turnReadRows`) of one step in one transaction. A row's `context_id` is the
 * execution context it was read in ('' when none was issued) and `reader_kind` who read it (`turn` by default).
 */
export function insertTurnReads(handle: MemoryHandle, turnId: string, step: unknown, rows: ReadonlyArray<Row>): void {
  handle.transaction(() => writeTurnReadRows(dbOf(handle), turnId, step, rows as Array<Row>)); // the rows are only read
}

/** Waits for a promise (if any) for at most `ms`; a rejection of it is the caller's own business. */
async function waitFor(promise: Promise<unknown> | null | undefined, ms: number): Promise<void> {
  if (!promise) return;
  let timer: NodeJS.Timeout | undefined;
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
/** The writer worker as the service holds it: `call` posts a message and answers with the worker's reply. */
type Engine = {
  dead: boolean;
  call(type: string, payload?: Row): Promise<Row>;
  stop(timeoutMs: number, lockFile?: string): Promise<void>;
};

function startWorker({
  workerFile,
  log,
  codeOf,
}: {
  workerFile: string | URL;
  log: Log;
  codeOf: (error: unknown) => string;
}): Engine {
  const worker = new Worker(workerFile);
  worker.unref();
  const pending = new Map<number, { resolve: (value: Row) => void; reject: (error: Error) => void }>();
  let seq = 0;
  let stopping = false;
  let logged = false;
  let exited = false;
  let onExit: () => void = () => {};
  const exit = new Promise<void>((resolve) => {
    onExit = resolve;
  });
  const engine: Engine = { dead: false, call, stop };

  function fail(code: string) {
    engine.dead = true;
    for (const waiting of pending.values())
      waiting.reject(Object.assign(new Error('memory db worker stopped'), { code }));
    pending.clear();
  }

  function call(type: string, payload: Row = {}): Promise<Row> {
    if (engine.dead)
      return Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' }));
    return new Promise<Row>((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      worker.postMessage({ ...payload, id: seq, type });
    });
  }

  worker.on('message', (posted: Row | null) => {
    if (posted?.type === 'log') {
      const level = posted.level as 'info' | 'warn' | 'error' | 'debug';
      log[level]?.(posted.message as string, posted.fields as Row | undefined);
      return;
    }
    const waiting = pending.get(posted?.id as number);
    if (!waiting || !posted) return;
    pending.delete(posted.id as number);
    if (posted.ok) waiting.resolve(posted.result as Row);
    else waiting.reject(Object.assign(new Error('memory db worker call failed'), { code: posted.code }));
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
  async function stop(timeoutMs: number, lockFile?: string): Promise<void> {
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

/** What a migration needs from the opener (open.ts#migrate): the selfreflection channel as a place, and the data directory. */
function openContextOf(config: Config, dataDir: string): { selfreflectionPlaceId: string | null; dataDir: string } {
  const channel = config?.selfreflection?.placeId;
  return {
    selfreflectionPlaceId: typeof channel === 'string' && channel ? channelPlaceId(LEGACY_IFACE, channel) : null,
    dataDir,
  };
}

/** The record unit of an observed line: its place's day (the UTC day of the line), or null with no place. */
function recordUnitOf(envelope: Row, where: Row | null): string | null {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(asText(envelope?.occurredAt ?? ''))?.[0];
  if (typeof where?.placeId !== 'string' || !where.placeId || !day) return null;
  return keyText(placeCollection('record', where.placeId, { partition: day }));
}

/** The pending files: [{ file, update }] (a file that does not parse is skipped and counted). */
function pendingWrites(pendingDir: string, log: Log): Array<{ file: string; update: Row }> {
  let names: Array<string> = [];
  try {
    names = fs
      .readdirSync(pendingDir)
      .filter((name) => /^[0-9a-f]{40}\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const out: Array<{ file: string; update: Row }> = [];
  let bad = 0;
  for (const name of names) {
    const file = path.join(pendingDir, name);
    const update = readPendingWrite(file);
    if (update) out.push({ file, update });
    else bad += 1;
  }
  if (bad > 0) log.error('memory db: pending unreadable', { count: bad });
  return out;
}

function keepUnitPending(given: unknown, pendingDir: string, now: () => number): string {
  const update = given as Row;
  const key = update.key as StorageKey | undefined;
  const owner = key ? keyText(key) : asText(update?.owner ?? '');
  if (!owner || (update.op !== 'value' && update.op !== 'lines' && update.op !== 'errand'))
    throw Object.assign(new Error('memory db: not a unit write'), { code: 'UNIT_BAD_OP' });
  const file = path.join(pendingDir, `${createHash('sha1').update(owner).digest('hex')}.json`);
  let lines: Array<unknown> | null = update.op === 'lines' ? (Array.isArray(update.lines) ? update.lines : []) : null;
  if (lines) {
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8')) as Row | null;
      if (
        ((key && held?.key && keyText(held.key as StorageKey) === owner) || held?.owner === owner) &&
        held.op === 'lines' &&
        Array.isArray(held.lines)
      )
        lines = [...(held.lines as Array<unknown>), ...lines];
    } catch {
      /* nothing kept yet */
    }
  }
  const kept = {
    ...(key ? { key } : { owner }),
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

/** What her memory session's schedule has done, failed at and told. */
type SessionState = {
  lastAt: number | null;
  lastOutcome: string | null;
  lastFailure: { code: unknown; at: number; scope: string | null; review?: boolean } | null;
  told: Set<unknown>;
  reviewFailDay: string | null;
  reviewFails: number;
  reviewSkip: Set<string>;
};

/** A turn-reads write that waits for a quiet loop: `run` starts it, `done` is its promise once started. */
type ReadJob = { run: () => Promise<void>; done: Promise<void> | null };

/** An observation waiting for the writer: the envelope, the record unit it belongs to and the tries so far. */
type ObserveItem = {
  type: 'observe' | 'observeMessage' | 'deleteMessage';
  envelope: Row;
  owner: string | null;
  attempts: number;
};

/** Sends either observation operation through the same worker or local writer boundary. */
function dispatchObservation(
  item: ObserveItem,
  engine: Engine | null,
  opened: () => MemoryHandle,
  now: () => number,
  log: Log
): Promise<Row> {
  const { envelope, owner } = item;
  if (engine) return engine.call(item.type, { envelope, now: now(), owner });
  const writers = {
    observe: observeEnvelope,
    observeMessage: observeMessageEnvelope,
    deleteMessage: deleteMessageEnvelope,
  };
  const write = writers[item.type];
  return Promise.resolve().then(() => write(opened(), envelope, { now, log, owner }));
}

function messageWriters(
  write: (envelope: unknown, where?: Row | null, type?: ObserveItem['type']) => Promise<object> | null
) {
  return {
    observeMessage: (envelope: unknown, where?: Row | null) => write(envelope, where, 'observeMessage'),
    deleteMessage: (envelope: unknown, where?: Row | null) => write(envelope, where, 'deleteMessage'),
  };
}

/** The state of the memory database for the status card (see `status`). */
export type MemoryDbStatus = {
  open: boolean;
  openedAt: number | null;
  files: number | null;
  rows: number | null;
  observe: { queued: number; writing: number; dropped: number };
  session: {
    running: boolean;
    lastAt: number | null;
    lastOutcome: string | null;
    lastFailure: { code: unknown; at: number; scope: string | null; review?: boolean } | null;
    reviewsFailedToday: number;
  };
  /** The pending writes that failed their replay and wait in `memory-pending-quarantine/` (pending-quarantine.ts). */
  pending: QuarantineStatus;
};

/** What `createMemoryDb` gives its callers. */
export type MemoryDbService = {
  namespace(): string | null;
  open(): Promise<void>;
  tick(): Promise<void>;
  database(): Db | null;
  readHandle(): MemoryHandle | null;
  /** A search of the record off the main thread (see the head of this file). */
  searchRecord(input: SearchInput, options?: { signal?: AbortSignal }): Promise<SearchResult>;
  recordTurnReads(args: {
    turnId: string;
    step?: unknown;
    placeId?: string | null;
    reads: unknown;
    contextId?: unknown;
    readerKind?: unknown;
  }): void;
  memoryWrite(update: unknown): Promise<unknown>;
  onAffinityMoves(fn: (moves: Array<Row>) => void): () => void;
  writeUnit(update: unknown): Promise<unknown>;
  /** The engine's own state by kind and subject (operational.ts). */
  writeOperational(write: OperationalWrite): Promise<unknown>;
  /** Her intentions and their archive (intentions-write.ts). */
  writeIntentions(write: IntentionsWrite): Promise<unknown>;
  keepPending(update: unknown): string;
  /** The writes in the quarantine, by name, with the code each failed with and when it moved. */
  quarantinedPending(): Array<QuarantinedPending>;
  /** Replays the quarantine through the writer: a file that applies goes, one that fails stays. `DB_CLOSED` if closed. */
  replayQuarantinedPending(): Promise<{ replayed: number; kept: number }>;
  recordWake(update: unknown): Promise<unknown> | null;
  issueContext(spec?: Parameters<typeof issuePureContext>[0]): Context;
  /** The budget of one retrieval from the settings read now; null while they are absent. */
  retrievalBoundsFor(purpose: MemoryQuery['purpose']): RetrievalBounds | null;
  /** One read of the retrieval service (retrieve.ts) on the read connection; null while memory is closed. */
  retrieveQuery(
    ctx: Context,
    query: MemoryQuery,
    options?: Pick<RetrieveDeps, 'sources' | 'plainClaims'>
  ): Promise<MemoryPage | null>;
  /** A consumer's input (retrieval-input.ts) read through `retrieveQuery`; null without settings or an open memory. */
  retrieve(
    ctx: Context,
    input: RetrievalInput,
    options?: Pick<RetrieveDeps, 'sources' | 'plainClaims'>
  ): Promise<MemoryPage | null>;
  /** The owner's binding of an account to a person (person-links.ts). */
  personLink(update: Row): Promise<Row>;
  /** The owner's merge of one person into another (person-merge.ts): `{ from, into, by, reason?, now? }`. */
  personMerge(update: Row): Promise<Row>;
  /** The owner's `/memory bind` of an account to a meta-person, a merge asked first (person-bind.ts). */
  personBind(input: BindInput, confirm: BindConfirm | null): Promise<BindResult>;
  /** The owner's snapshots of the whole database (inspection-snapshots.ts), null while it is closed. */
  inspection(): InspectionPort | null;
  /** The private view of a person or a DM place (private-read.ts). Throws `DB_CLOSED` while memory is closed. */
  privateByPerson(personId: string, context: Context): PrivatePersonView;
  privateByPlace(placeId: string, context: Context): PrivatePlaceView;
  observe(envelope: unknown, where?: Row | null): Promise<object> | null;
  observeMessage(envelope: unknown, where?: Row | null): Promise<object> | null;
  deleteMessage(input: unknown, where?: Row | null): Promise<object> | null;
  waitObservations(): Promise<number>;
  focusPeople(options?: {
    iface?: string;
  }): { exploringShare: number; close: Array<string>; exploring: Array<string> } | null;
  status(): MemoryDbStatus;
  close(): Promise<void>;
  waitSession(): Promise<void>;
};

/**
 * Everything `createMemoryDb` takes: the live config, the data directory and the seams the tests replace.
 * `selfreflectionMediaDeps` (read at each tick) gives the interface port and the image fetcher the selfreflection media job needs
 * (selfreflection-media.ts); without it the job does nothing. `defer` runs a function on the next turn of the event loop
 * (setImmediate), injected by the tests. `embed` is the embedding client's `embed(texts, { config, purpose })` (the
 * re-embed job; none: the job does nothing), `commit` the engine commit an inspection snapshot names (default
 * `git rev-parse HEAD`), `selfName()` her name in a rebuilt embedding input.
 */
export type MemoryDbOptions = {
  hot: { config: Config; prompts?: Row | null };
  dataDir: string;
  log?: Log;
  now?: () => number;
  open?: (path: string, opts?: Row) => MemoryHandle;
  defer?: (fn: () => unknown) => unknown;
  worker?: boolean;
  workerFile?: string | URL;
  readerFile?: string | URL;
  selfreflectionMediaDeps?: (() => { port?: unknown; imageFetcher?: unknown } | null) | null;
  selfreflectionSleep?: (ms: number) => Promise<void>;
  embed?: ((texts: ReadonlyArray<string>, opts: Row) => Promise<unknown>) | null;
  commit?: string | null;
  selfName?: () => string | null | undefined;
  sessionLlm?: () => SessionContext['llm'] | null;
  /** The event loop watch's `track` (src/loop-watch.ts), handed to the memory session. */
  track?: Track;
  sessionEnv?: () => Row | null;
  /** The core's key ring while `keys.json` exists, else null: the memory key comes from it (see `memoryKeyState`). */
  sessionKeys?: () => KeyRing | null;
  /** The memory writer's path now (src/subharness/memory-path.ts#memoryPath); absent is the direct path. */
  sessionPath?: () => MemoryPath;
  onSessionFailure?: ((failure: Row) => void) | null;
  sessionLookMs?: number;
  /** Told once per open that quarantined pending writes: `{ count, code: 'memory-pending-quarantined', cause }`. */
  onPendingQuarantined?: ((info: { count: number; code: string; cause: string | null }) => void) | null;
  iface?: () => string | null;
};

/** A DM reads the history of the person: the context carries the DMs of every account bound to this one. */
function linkedContext(ctx: Context, read: Db | null): Context {
  if (read === null || ctx.kind !== 'dm' || !ctx.person) return ctx;
  return { ...ctx, linked: linkedDmScopes(read, ctx.person, ctx.place ?? null) };
}

/** The private view of a person or a DM place, read over whichever connection is open when it is asked for. */
function privateReads(db: () => Db): Pick<MemoryDbService, 'privateByPerson' | 'privateByPlace'> {
  return {
    privateByPerson: (personId, context) => privateByPerson(db(), personId, context),
    privateByPlace: (placeId, context) => privateByPlace(db(), placeId, context),
  };
}

function databaseSettings(config: Config) {
  const given = config?.memoryDb ?? {};
  const closeMs = given.closeTimeoutMs;
  return {
    file: typeof given.file === 'string' && given.file ? given.file : DEFAULT_FILE,
    closeMs: isFiniteNumber(closeMs) && closeMs > 0 ? closeMs : DEFAULT_CLOSE_TIMEOUT_MS,
  };
}

const codeOf = (error: unknown): string => {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code ?? name ?? 'ERROR';
};

/** Report effective model choices after the core's dependencies are available. */
function reportEffectiveModels(config: Config, ring: KeyRing | null, log: Log): Promise<void> {
  return import('./writer-switch.ts')
    .then(({ effectiveModels, effectiveModelsLine }) =>
      log.info('memory db: effective models', { purposes: effectiveModelsLine(effectiveModels(config, ring)) })
    )
    .catch((error) => log.warn('memory db: effective models failed', { code: codeOf(error) }));
}

const SESSION_FAILURES = new Set([
  'llm_error',
  'bad_answer',
  'build_error',
  'write_failed',
  'not_configured',
  'skipped',
]);

// health: allow function-length until 2027-04-01 -- the closure holds its whole operation, grown by the one dependency that names the loop watch
export function createMemoryDb({
  hot,
  dataDir,
  log = silent,
  now = Date.now,
  open,
  defer = (fn: () => unknown) => setImmediate(fn),
  worker: useWorker,
  workerFile = WORKER_FILE,
  readerFile = READER_FILE,
  selfreflectionMediaDeps = null,
  selfreflectionSleep,
  embed = null,
  commit = null,
  selfName = () => '',
  sessionLlm = () => null,
  track = untracked,
  sessionEnv = () => null,
  sessionKeys = () => null,
  sessionPath = (): MemoryPath => ({ kind: 'direct' }),
  onSessionFailure = null,
  sessionLookMs = 60_000,
  onPendingQuarantined = null,
  iface = () => null,
}: MemoryDbOptions): MemoryDbService {
  const threaded = useWorker ?? open === undefined;
  const openDb = open ?? openMemoryDb;
  let handle: MemoryHandle | null = null;
  let engine: Engine | null = null;
  let reader: ReaderClient | null = null;
  let inspectionPort: InspectionPort | null = null;
  let openedAt: number | null = null;
  const pendingReads = new Set<ReadJob>();
  const writingReads = new Set<Promise<void>>();
  let closing = false;
  let closed = false;
  const openErrors = new Set<string>();

  /** The open handle, for a closure that runs after the caller checked `handle` and `handle` may have closed since. */
  function opened(): MemoryHandle {
    if (handle === null) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    return handle;
  }

  const settings = () => databaseSettings(hot.config);
  // While the pending unit writes of the last shutdown are replayed at an open, nothing reads the database.
  let replaying = false;
  const pendingDir = path.join(dataDir, PENDING_DIR);
  const quarantineDir = path.join(dataDir, QUARANTINE_DIR);

  // What a migration needs from the opener (openContextOf).
  const openContext = () => openContextOf(hot.config, dataDir);

  let opening: Promise<void> | null = null;
  let startupPending = false;

  async function openNow() {
    const { file } = settings();
    const dbPath = path.join(dataDir, file);
    let started: Engine | null = null;
    try {
      if (threaded) {
        started = startWorker({ workerFile, log, codeOf });
        await started.call('open', { path: dbPath, context: openContext(), now: now() });
        handle = openDb(dbPath, { readOnly: true });
        engine = started;
      } else {
        handle = openDb(dbPath, { context: openContext() });
        recoverRequestArchive(handle, { now: now() });
      }
      // The writes a shutdown left pending go in before anything reads (synchronous without a worker).
      await replayPending();
      // A turn's prefetch has a short deadline: the reader's start does not spend it.
      if (engine) await openReader().warm();
      openedAt = now();
      openErrors.clear();
      log.info('memory db: opened', { file });
      startupPending = true;
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

  /** Open and import state without invoking maintenance or core callbacks. */
  async function readyOpen(): Promise<void> {
    if (!handle && !closing) {
      opening ??= openNow().finally(() => {
        opening = null;
      });
      await opening;
    }
    if (!readHandle()) throw Object.assign(new Error('DB_CLOSED'), { code: 'DB_CLOSED' });
  }

  /** Ends the reader of this open; a later open starts its own. */
  async function stopReader(timeoutMs: number): Promise<void> {
    const ending = reader;
    reader = null;
    await ending?.stop(timeoutMs);
  }

  /** The reader of this open, started at its first use. */
  function openReader(): ReaderClient {
    reader ??= createReaderClient({
      workerFile: readerFile,
      dbPath: path.join(dataDir, settings().file),
      log,
    });
    return reader;
  }

  /** Closes the database; the worker gets `timeoutMs` to finish what it holds, then it is terminated. */
  async function closeNow(timeoutMs = settings().closeMs) {
    if (!handle && !engine) return;
    await stopReader(timeoutMs);
    if (handle) {
      try {
        handle.close();
      } catch (error) {
        log.warn('memory db: close failed', { code: codeOf(error) });
      }
    }
    const worker = engine;
    inspectionPort?.closeAll();
    inspectionPort = null;
    handle = null;
    engine = null;
    openedAt = null;
    if (worker) await worker.stop(timeoutMs, lockPathOf(path.join(dataDir, settings().file)));
    log.info('memory db: closed', {});
  }

  // The selfreflection's text and pictures (selfreflection-media.ts): off by default, one run per start over the rows still without text.
  const selfreflectionJob = createSelfreflectionMedia({
    db: () => (handle ? dbOf(handle) : null),
    apply: (update: Row) =>
      engine ? engine.call('selfreflectionApply', { update }) : applySelfreflectionUpdate(opened(), update),
    port: () => selfreflectionMediaDeps?.()?.port ?? null,
    imageFetcher: () => selfreflectionMediaDeps?.()?.imageFetcher ?? null,
    config: () => hot.config,
    dataDir,
    log,
    sleep: selfreflectionSleep,
  });
  function startSelfreflectionMedia() {
    if (closing || !handle) return;
    if (engine?.dead) return;
    if (!selfreflectionJob.hasWork()) return;
    selfreflectionJob
      .run()
      .catch((error: unknown) => log.warn('selfreflection media: run failed', { code: codeOf(error) }));
  }

  /** The stamped unit write as `writeUnit` sends it (the time, a selfreflection's destination). */
  function stampUnit(update: Row): Row {
    const stamped: Row = { ...update, kind: 'unit', now: Number.isFinite(update?.now) ? update.now : now() };
    // A selfreflection post's destination is the place of the selfreflection's first enabled mirror (mirrors.ts).
    if (
      (stamped.op === 'selfreflection' ||
        (stamped.op === 'value' &&
          ((stamped.key as StorageKey | undefined)?.kind === 'selfreflection' ||
            isLegacySelfreflectionFile(asText(stamped.owner ?? ''))))) &&
      stamped.destination === undefined
    ) {
      stamped.destination = readMirrors({ readHandle }, mirrorPlaces, [])[0]?.placeId ?? null;
    }
    return withLiveIface(stamped, iface);
  }

  /**
   * Keeps a unit write that could not be made (unit-outbox.ts#keep, at shutdown) in `memory-pending/`, replayed at the
   * next open. A value replaces the one kept for its owner; lines are appended to the kept ones. Throws on an I/O
   * failure (the caller logs it). Returns the file's path.
   */
  const keepPending = (given: unknown): string => keepUnitPending(given, pendingDir, now);

  /**
   * Replays the pending writes through the writer at the open, each file deleted once its write resolved: in line
   * without a worker, returning nothing, and as the promise it returns with one. A write that fails moves to the
   * quarantine (pending-quarantine.ts) and the open goes on; one that cannot move keeps its file and the open rejects.
   */
  function replayPending() {
    const writes = pendingWrites(pendingDir, log);
    if (writes.length === 0) return null;
    replaying = true;
    const failed = { stuck: 0, moved: 0, code: null as string | null };
    const done = (file: string): void => {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* removed at the next replay */
      }
    };
    const fail = (file: string, error: unknown) => {
      const code = codeOf(error);
      failed.code = code;
      try {
        quarantinePending(file, quarantineDir, code, new Date(now()).toISOString());
        failed.moved += 1;
      } catch {
        failed.stuck += 1;
      }
    };
    const finish = () => {
      replaying = false;
      tellQuarantined(failed.moved, failed.code);
      if (failed.stuck > 0) {
        log.error('memory db: pending replay failed', { count: failed.stuck, code: failed.code });
        throw Object.assign(new Error('memory db: pending writes not replayed'), { code: 'PENDING_REPLAY' });
      }
      log.info('memory db: pending replayed', { count: writes.length - failed.moved });
    };
    if (!engine) {
      for (const { file, update } of writes) {
        try {
          noteSkipped(log, applyMemoryWrite(opened(), stampUnit(update)));
          done(file);
        } catch (error) {
          fail(file, error);
        }
      }
      return finish();
    }
    return (async () => {
      for (const { file, update } of writes) {
        try {
          noteSkipped(log, await engine.call('memoryWrite', { update: stampUnit(update) }));
          done(file);
        } catch (error) {
          fail(file, error);
        }
      }
      finish();
    })();
  }

  /** The error line and the core's notice of `count` writes moved to the quarantine at this open. */
  function tellQuarantined(count: number, cause: string | null): void {
    if (count === 0) return;
    log.error('memory db: pending quarantined', { count, code: cause });
    try {
      onPendingQuarantined?.({ count, code: CODE.MEMORY_PENDING_QUARANTINED, cause });
    } catch (error) {
      log.warn('memory db: pending quarantine not told', { code: codeOf(error) });
    }
  }

  /** The owner's replay of the quarantine through the writer: each file that applies goes, each that fails stays. */
  async function replayQuarantinedPending(): Promise<{ replayed: number; kept: number }> {
    if (!handle || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    const counts = { replayed: 0, kept: 0 };
    for (const { name } of quarantinedIn(quarantineDir)) {
      const file = path.join(quarantineDir, name);
      try {
        const update = readPendingWrite(file);
        if (update === null) throw Object.assign(new Error('not a unit write'), { code: 'PENDING_UNREADABLE' });
        await writeUnit(update);
        releaseQuarantined(file);
        counts.replayed += 1;
      } catch (error) {
        counts.kept += 1;
        if (codeOf(error) === 'DB_CLOSED') throw error;
        try {
          writeError(file, codeOf(error), new Date(now()).toISOString());
        } catch {
          /* the older code stays beside it */
        }
      }
    }
    log.info('memory db: quarantine replayed', counts);
    return counts;
  }

  /** One write on the writer connection: a message to the worker, or this thread's own connection. */
  function write(update: Row): Promise<Row> {
    if (!handle || closing)
      return Promise.reject(Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' }));
    if (engine) return engine.call('memoryWrite', { update });
    return Promise.resolve().then(() => applyMemoryWrite(opened(), update) as Row);
  }

  /** What each open does once (schema v11): stale wake runs interrupted. */
  function startupJobs() {
    const budget = hot.config?.wakes?.loop?.timeBudgetMs;
    write({
      kind: 'wake',
      op: 'interrupt',
      now: now(),
      limitMs: typeof budget === 'number' && budget > 0 ? budget : DEFAULT_TURN_BUDGET_MS,
    })
      .then((done: Row) => {
        if (Number(done?.interrupted) > 0) log.debug?.('memory db: wake runs interrupted', { runs: done.interrupted });
      })
      .catch((error: unknown) => log.warn('memory db: wake interrupt failed', { code: codeOf(error) }));
  }

  /** One write of the inner life's wake runs (wakes.ts#applyWakeWrite) through the writer while open, else null. */
  function recordWake(given: unknown): Promise<unknown> | null {
    const update = given as Row;
    if (!handle || closing || update?.kind !== 'wake') return null;
    return write(update);
  }

  /**
   * One observation of the live message path (observe.ts#observe) through the writer: resolves the observe result
   * (`{ ok, ... }` or `{ ok: false, code }`) while the database is open, else null (the observation waits in the queue
   * below). A failed write is logged with a code and resolves null: never a turn's failure. `where` (`{ placeId }`)
   * names the record the line belongs to: the observation is the record of the line (its record unit is passed to
   * observe.ts), and a write that failed (not a refusal) stays in the queue below and is tried again at the next tick,
   * up to OBSERVE_ATTEMPTS times (then dropped, a warning).
   */
  // Observations that came while the database was not open yet (the start's catch-up runs before it opens) wait here
  // and are written right after it opens; a shutdown writes the waiting ones and those under way before it closes.
  // Bounded: past OBSERVE_QUEUE_MAX the oldest is dropped. Every dropped observation is counted (`status().observe`):
  // the first drop of a run of drops is a warning at once, and the run's count is a warning when the queue is next
  // written (the open, a tick) or at the shutdown; what the shutdown could not write is counted the same way.
  const OBSERVE_QUEUE_MAX = 5000;
  const OBSERVE_ATTEMPTS = 5;
  const observeQueue: Array<ObserveItem> = [];
  const observing = new Set<Promise<Row | null>>();
  let observeDropped = 0;
  let observeShutdown = false;
  // The drops not yet reported by a count warning, by reason.
  const droppedUntold = new Map<string, number>();

  /** One dropped observation, counted (see above). */
  function dropObservation(reason: string) {
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
  const observeOn = (envelope: unknown): envelope is Row => envelope !== null && typeof envelope === 'object';

  /** Queues an observation (bounded: the oldest goes first, counted). */
  function queueObservation(item: ObserveItem): void {
    observeQueue.push(item);
    if (observeQueue.length > OBSERVE_QUEUE_MAX) {
      observeQueue.shift();
      dropObservation('queue_full');
    }
  }

  function sendObservation(item: ObserveItem): Promise<Row | null> {
    const done = dispatchObservation(item, engine, opened, now, log)
      .then((result: Row) => {
        if (result && result.ok === false) log.warn('memory db: observe refused', { code: result.code ?? null });
        return result;
      })
      .catch((error: unknown) => {
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
    void done.finally(() => observing.delete(done));
    return done;
  }

  function observe(
    envelope: unknown,
    where: Row | null = null,
    type: ObserveItem['type'] = 'observe'
  ): Promise<object> | null {
    if (!observeOn(envelope)) return null;
    const item = { type, envelope, owner: recordUnitOf(envelope, where), attempts: 0 };
    if (!handle) {
      if (closed) {
        dropObservation('closed');
        return null;
      }
      queueObservation(item);
      return null;
    }
    // The callers type the answer as an object: a write that failed was logged and resolves null, as it always did.
    return sendObservation(item) as Promise<object>;
  }

  /** Writes the observations that waited (for the database to open, or for a retry), in arrival order. */
  function drainObservations() {
    if (!handle || observeQueue.length === 0) return;
    tellDropped();
    const waiting = observeQueue.splice(0, observeQueue.length);
    log.info('memory db: observations written after open', { count: waiting.length });
    for (const item of waiting) void sendObservation(item);
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
   * One write of a memory unit (unit-write.ts) through the writer. Resolves the writer's counts once committed (a skipped
   * errand unit logged with its count); rejects with a code (`DB_CLOSED` while the database is not open).
   */
  async function writeUnit(given: unknown): Promise<unknown> {
    const update = given as Row;
    if (!handle || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    const stamped = stampUnit(update);
    if (engine) return noteSkipped(log, await engine.call('memoryWrite', { update: stamped }));
    return noteSkipped(log, applyMemoryWrite(handle, stamped) as Row);
  }

  // The graph projection a migration left pending and the stems of new lines: the writer finishes them, one slice per
  // tick (unit-write.ts, op `project`).
  let projectRun: Promise<void> | null = null;
  function startProject() {
    if (closing || !handle || projectRun || engine?.dead) return;
    let due = false;
    try {
      due = graphPending(handle) || stemsPending(dbOf(handle));
    } catch {
      due = false;
    }
    if (!due) return;
    projectRun = writeUnit({ op: 'project', maxSlices: 1 })
      .then((answer) => {
        const projected = answer as Row;
        if (Number(projected?.units) > 0 || Number(projected?.stems) > 0)
          log.debug?.('memory db: projected', { units: projected.units, stems: projected.stems, done: projected.done });
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
  async function flushObservations(timeoutMs: number) {
    drainObservations();
    await waitFor(Promise.allSettled([...observing]), timeoutMs);
    observeShutdown = true;
    for (let n = observeQueue.length; n > 0; n -= 1) dropObservation('shutdown');
    observeQueue.length = 0;
  }

  /** The sources `ids` were read by a request or a session: touched (index-policy.ts#touch) while eviction is on. */
  function touchSources(ids: ReadonlyArray<unknown>): void {
    if (!handle || closing || !indexSettings(hot.config).eviction) return;
    const sources = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
    if (sources.length === 0) return;
    write({
      kind: 'touch',
      sourceIds: sources,
      now: now(),
      config: { recall: { db: hot.config?.recall?.db ?? {} } },
    }).catch((error: unknown) => log.warn('memory db: touch failed', { code: codeOf(error) }));
  }

  // The index policy (index-policy.ts): once per UTC day while `recall.db.vectorEviction` is on, through the writer.
  let indexRun: Promise<void> | null = null;
  let indexDay: string | null = null;
  function startIndexPolicy() {
    if (closing || !handle || indexRun || engine?.dead) return;
    if (!indexSettings(hot.config).eviction) return;
    const at = now();
    const day = utcDay(at);
    if (indexDay === day) return;
    indexRun = write({ kind: 'index-policy', now: at, config: { recall: { db: hot.config?.recall?.db ?? {} } } })
      .then((done: Row) => {
        indexDay = day;
        log.debug?.('memory db: index policy', {
          a: (done?.tiers as Row | undefined)?.a ?? 0,
          b: (done?.tiers as Row | undefined)?.b ?? 0,
          c: (done?.tiers as Row | undefined)?.c ?? 0,
          evicted: done?.evicted ?? 0,
        });
      })
      .catch((error: unknown) => log.warn('memory db: index policy failed', { code: codeOf(error) }))
      .finally(() => {
        indexRun = null;
      });
  }

  // Semantic documents (semantic-search.ts) and memory objects (object-vectors.ts): one embedding batch a minute each.
  const embedJobs: Record<string, { run: Promise<unknown> | null; at: number }> = {};
  function startRetrievalEmbed(key: 'embedDocuments' | 'embedObjects') {
    const job = (embedJobs[key] ??= { run: null, at: -Infinity });
    if (closing || !handle || job.run || engine?.dead || typeof embed !== 'function') return;
    const config = hot.config;
    if ((config?.memoryDb?.retrieval as Row | undefined)?.[key] !== true) return;
    const at = now();
    if (at - job.at < REEMBED_EVERY_MS) return;
    job.at = at;
    const db = dbOf(handle);
    job.run = (async () => {
      const model = (await import('../../llm/roles.ts')).roleModel(config, 'embedding');
      if (typeof model !== 'string' || model === '') return;
      const run = key === 'embedObjects' ? embedObjects : embedSemanticDocuments;
      await run({ db, write, embed, config, model, now: at });
    })()
      .catch((error: unknown) => log.warn('memory db: embedding job failed', { job: key, code: codeOf(error) }))
      .finally(() => {
        job.run = null;
      });
  }

  // The re-embed job (index-policy.ts#reembedTouched): `recall.db.reembed` with an embedding client, at most once a minute.
  let reembedRun: Promise<void> | null = null;
  // The embedding of media text forms (media-store.ts#embedMedia): at most once a minute, a bounded page each time.
  let mediaEmbedRun: Promise<void> | null = null;
  let mediaEmbedAt = -Infinity;
  function startMediaEmbed() {
    if (closing || !handle || mediaEmbedRun || engine?.dead || typeof embed !== 'function') return;
    const at = now();
    if (at - mediaEmbedAt < REEMBED_EVERY_MS) return;
    mediaEmbedAt = at;
    const db = dbOf(handle);
    mediaEmbedRun = (async () => {
      const [{ quantize }, { roleModel }] = await Promise.all([import('../vectors.ts'), import('../../llm/roles.ts')]);
      const config = hot.config;
      return embedMedia({
        db,
        write: (update) => write({ kind: 'media-embed', ...update }),
        embed,
        config,
        now: at,
        quantize,
        model: roleModel(config, 'embedding') ?? null,
      });
    })()
      .then((done) => {
        if (done.pending > 0) log.debug?.('memory db: media embed', { embedded: done.embedded, written: done.written });
      })
      .catch((error) => log.warn('memory db: media embed failed', { code: codeOf(error) }))
      .finally(() => {
        mediaEmbedRun = null;
      });
  }
  let reembedAt = -Infinity;
  function startReembed() {
    if (closing || !handle || reembedRun || engine?.dead || typeof embed !== 'function') return;
    if (!indexSettings(hot.config).reembed) return;
    const at = now();
    if (at - reembedAt < REEMBED_EVERY_MS) return;
    reembedAt = at;
    const db = dbOf(handle);
    reembedRun = (async () => {
      const [{ quantize }, { recordChunk }, { roleModel }] = await Promise.all([
        import('../vectors.ts'),
        import('../chunks.ts'),
        import('../../llm/roles.ts'),
      ]);
      const config = hot.config;
      const nameOf = (id: string) => {
        try {
          const names = JSON.parse(
            (db.prepare('SELECT names FROM accounts WHERE native_id = ? LIMIT 1').get(id)?.names as
              string | undefined) ?? 'null'
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
        chunkOf: (line: object, context: Array<object> | undefined) =>
          recordChunk(line, context, { nameOf, selfName: selfName() ?? '' }).text,
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

  // The focus job (focus.ts): once per UTC day, through the writer, with the live settings.
  let focusRun: Promise<void> | null = null;
  let focusDay: string | null = null;
  function startFocus() {
    if (closing || !handle || focusRun || engine?.dead) return;
    const at = now();
    const day = utcDay(at);
    if (focusDay === day) return;
    try {
      if (lastFocusDay(dbOf(handle)) === day) {
        focusDay = day;
        return;
      }
    } catch {
      /* a database before v10: the job runs and fails with a code */
    }
    const config = { focus: hot.config?.focus ?? null };
    const job = engine
      ? engine.call('focus', { now: at, config })
      : Promise.resolve().then(() => runFocusDay(opened(), { now: at, config }));
    focusRun = job
      .then((done: Row) => {
        focusDay = day;
        log.debug?.('memory db: focus', {
          days: done.days,
          rows: done.rows,
          close: done.close,
          exploring: done.exploring,
          events: done.events,
        });
      })
      .catch((error: unknown) => log.warn('memory db: focus failed', { code: codeOf(error) }))
      .finally(() => {
        focusRun = null;
      });
  }

  /**
   * The focus sets for the heartbeat's people view (focus.ts#focusView, an internal read): `{ close, exploring,
   * exploringShare }` as member ids of the interface, each the best scored first; null while the database is closed.
   */
  function focusPeople({ iface = LEGACY_IFACE }: { iface?: string } = {}) {
    if (!handle) return null;
    try {
      const sets = focusView(dbOf(handle), { iface });
      return { ...sets, exploringShare: FOCUS_DEFAULTS.exploringShare };
    } catch (error) {
      log.warn('memory db: focus read failed', { code: codeOf(error) });
      return null;
    }
  }

  // The effective models and her memory session's schedule (see the head of this file).
  let modelsLogged = false;
  let sessionRun: Promise<void> | null = null;
  let sessionLookAt = -Infinity;
  const sessionState: SessionState = {
    lastAt: null,
    lastOutcome: null,
    lastFailure: null,
    told: new Set(),
    reviewFailDay: null,
    reviewFails: 0,
    reviewSkip: new Set(),
  };

  /** The start-up line of the effective models (codes and model ids only, never a key value). */
  function logEffectiveModels() {
    if (modelsLogged) return Promise.resolve();
    modelsLogged = true;
    return reportEffectiveModels(hot.config, sessionKeys(), log);
  }

  /** One failing scope told once (`onSessionFailure`) until it runs fine again, with the scope the run names. */
  function sessionFailed(run: Row, at: number): void {
    const code = run.outcome;
    const scopeKind = typeof run.scopeKind === 'string' ? run.scopeKind : null;
    sessionState.lastFailure = { code, at, scope: scopeKind };
    log.warn('memory session: run failed', { code, scope: scopeKind, lines: run.lines ?? 0 });
    if (sessionState.told.has(run.scope)) return;
    sessionState.told.add(run.scope);
    if (typeof onSessionFailure !== 'function') return;
    try {
      onSessionFailure({
        scopeKey: run.scope,
        scopeKind,
        iface: run.iface ?? null,
        place: scopeKind === 'dm' ? (run.place ?? null) : null,
        code,
        lines: run.lines ?? 0,
        at,
      });
    } catch (error) {
      log.warn('memory session: the failure could not be told', { code: codeOf(error) });
    }
  }

  /** One scheduled look: a sweep over the due scopes, then the reviews her flags ask for. Never throws. */
  async function sessionJob(at: number) {
    const [
      { sweep, refusalOf, sessionSettings },
      { reviewDescription, reviewRefusal },
      { dueScopes, openFlags, reviewsToday },
    ] = await Promise.all([import('./session.ts'), import('./describe.ts'), import('./writer-switch.ts')]);
    const config = hot.config;
    const env = sessionEnv?.() ?? null;
    const llm = sessionLlm?.() ?? null;
    const ring = sessionKeys();
    const path = sessionPath;
    if (!llm || !handle || refusalOf(config, env, hot.prompts, ring, path())) return;
    const db = dbOf(handle);
    const ctx = { db, write: memoryWrite, llm, hot, env, ring, path, now, log, selfName: selfName() ?? '', track };
    const due = track('session.batch', () => dueScopes(db, config, at, { log }));
    if (due.length > 0) {
      const result = await sweep({ ...ctx, embed }, { scopes: new Set(due.map((scope) => scope.key)) });
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
    if (closing || !handle || reviewRefusal(config, env, hot.prompts, ring, path())) return;
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

  /** The port over this open of the database: its connections are its own, and `closeNow` ends them. */
  const inspection = (): InspectionPort | null => {
    if (readHandle() === null || closing) return null;
    inspectionPort ??= createInspectionPort({
      dbPath: path.join(dataDir, settings().file),
      now,
      engineRevision: typeof commit === 'string' ? commit : engineCommit(),
      log,
    });
    return inspectionPort;
  };

  /** The tick: opens the database when it is not open, then runs the jobs that are due. Safe to call at any rate. */
  async function tick() {
    if (closing) return;
    inspectionPort?.sweepExpired();
    if (engine?.dead) await closeNow(0);
    if (!handle) {
      try {
        await readyOpen();
      } catch {
        return;
      }
    }
    if (startupPending) {
      startupPending = false;
      await logEffectiveModels();
      startupJobs();
    }
    drainObservations();
    startProject();
    startSelfreflectionMedia();
    startFocus();
    startIndexPolicy();
    startReembed();
    startMediaEmbed();
    for (const key of ['embedDocuments', 'embedObjects'] as const) startRetrievalEmbed(key);
    startSession();
  }

  /** The database for recall (src/memory/db/recall.ts): the read-only connection while it is open, else null. */
  const database = () => (handle !== null && !replaying ? dbOf(handle) : null);

  /** A search of the record: on the reader thread, or on this thread's connection without a worker. */
  async function searchRecord(input: SearchInput, { signal }: { signal?: AbortSignal } = {}): Promise<SearchResult> {
    const db = closing || closed ? null : database();
    if (db === null) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    if (engine) return openReader().search(input, signal);
    if (signal?.aborted) throw Object.assign(new Error('memory db search abandoned'), { code: SEARCH_ABANDONED });
    return search(db, input);
  }

  /**
   * The memory a turn's request carried (prompt.js `memoryReads`), written as turn_reads rows of its step, deferred.
   * `contextId` is the execution context of the read (`issueContext`), `readerKind` `turn` (default), `session` or `wake`.
   */
  function recordTurnReads({
    turnId,
    step = 's0',
    placeId = null,
    reads: carried,
    contextId = null,
    readerKind = 'turn',
  }: {
    turnId: string;
    step?: unknown;
    placeId?: string | null;
    reads: unknown;
    contextId?: unknown;
    readerKind?: unknown;
  }): void {
    if (!handle || !turnId || !Array.isArray(carried) || carried.length === 0) return;
    // Resolved now, from the rows as they are when the request is assembled; only the write waits for a quiet loop.
    let rows: Array<Row>;
    try {
      rows = turnReadRows(dbOf(handle), carried, { placeId, iface: liveIface(iface) ?? LEGACY_IFACE });
    } catch (error) {
      log.warn('memory db: turn reads failed', { code: codeOf(error) });
      return;
    }
    if (rows.length === 0) return;
    const context = typeof contextId === 'string' ? contextId : '';
    const reader = READER_KINDS.includes(readerKind as string) ? readerKind : 'turn';
    rows = rows.map((row) => ({ ...row, context_id: context, reader_kind: reader }));
    // The lines a request carried were shown to her: touched while eviction is on (their vectors come back).
    touchSources(rows.filter((row) => row.row_kind === 'sources').map((row) => row.row_id));
    // The write waits for a quiet loop, but a shutdown never drops it: `close` runs every queued write, then those under
    // way, before the database closes.
    // `run` is set just below: the function needs `job` itself.
    const job: ReadJob = { run: () => Promise.resolve(), done: null };
    job.run = () => {
      if (job.done) return job.done;
      pendingReads.delete(job);
      const done = (async () => {
        if (engine && !engine.dead) {
          try {
            const done = await engine.call('turnReads', { turnId: String(turnId), step: String(step), rows });
            if (Number(done.rows) > 0) log.debug?.('memory db: turn reads', { rows: done.rows });
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
      job.done = done;
      writingReads.add(done);
      void done.finally(() => writingReads.delete(done));
      return done;
    };
    pendingReads.add(job);
    defer(job.run);
  }

  /** Runs every queued turn-reads write now and waits for all of them (shutdown). */
  async function flushTurnReads(timeoutMs: number) {
    for (const job of [...pendingReads]) void job.run();
    await waitFor(Promise.allSettled([...writingReads]), timeoutMs);
  }

  // Her session's attitude moves, told to whoever caches the people they move (the store: a profile it holds would
  // otherwise write its older score over the move at its next flush). Each committed move is told once, after its
  // apply, also when the apply's answer was lost (the move is read back from the database by its run).
  const affinityListeners = new Set<(moves: Array<Row>) => void>();
  const toldMoves = new Set<unknown>();
  const TOLD_MOVES_KEPT = 10_000;

  /** Subscribes `fn(moves)` (`[{ personId, applied, score }]`) to her session's committed attitude moves; returns the unsubscribe. */
  function onAffinityMoves(fn: (moves: Array<Row>) => void): () => void {
    if (typeof fn !== 'function') return () => {};
    affinityListeners.add(fn);
    return () => affinityListeners.delete(fn);
  }

  /** The committed attitude moves of run `runId` not told yet, told to every listener (a failure is a warning, never the write's). */
  function tellAffinityMoves(runId: unknown) {
    if (affinityListeners.size === 0 || typeof runId !== 'string' || !runId || !handle) return;
    let moves: Array<Row> = [];
    try {
      const prefix = `aff:${runId}:`;
      moves = dbOf(handle)
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
   * One write of her memory session or a description review (session-write.ts), on the writer connection: a message
   * to the worker, or the calling thread's own connection when there is no worker. Rejects when the database is closed.
   * A session's apply then tells its attitude moves (`onAffinityMoves`), whether its answer came back or not.
   */
  async function memoryWrite(given: unknown): Promise<unknown> {
    const update = given as Row;
    if (!handle || closing) throw Object.assign(new Error('memory db is not open'), { code: 'DB_CLOSED' });
    // The target check reads through `audience_id`; a selfreflection entry's media go under the data directory.
    const stamped = { ...update, audienceColumn: true, dataDir };
    // A session's batch read its lines: touched while eviction is on.
    if (update?.kind === 'session' && Array.isArray(update.reads))
      touchSources(update.reads.filter((row: Row) => row?.row_kind === 'sources').map((row: Row) => row.row_id));
    const applies = update?.kind === 'session' && update.mode === 'apply';
    try {
      if (engine) return await engine.call('memoryWrite', { update: stamped });
      return applyMemoryWrite(handle, stamped);
    } finally {
      if (applies) tellAffinityMoves((update.run as { id?: unknown } | undefined)?.id);
    }
  }

  function retrievalBoundsFor(purpose: MemoryQuery['purpose']): RetrievalBounds | null {
    const config = hot.config;
    if (!config?.memoryDb?.retrieval) return null;
    const prefetch = recallSettings(config)?.prefetch;
    return retrievalBounds({ recall: { prefetch }, memoryDb: config.memoryDb }, purpose);
  }

  async function retrieveQuery(
    ctx: Context,
    query: MemoryQuery,
    options: Pick<RetrieveDeps, 'sources' | 'plainClaims'> = {}
  ): Promise<MemoryPage | null> {
    if (!handle) return null;
    const config = hot.config;
    const { roleModel } = await import('../../llm/roles.ts');
    const model = roleModel(config, 'embedding', 'recall-query');
    const recall = dbSettings(config);
    const embedOne = embed;
    return retrieveMemory(database() as Db, ctx, query, {
      ...options,
      now,
      model: typeof model === 'string' ? model : null,
      embedQuery:
        typeof embedOne === 'function' && typeof model === 'string'
          ? async (text) =>
              ((await embedOne([text], { config, purpose: 'recall-query' })) as Array<ArrayLike<number>>)?.[0] ?? null
          : null,
      recall,
      minSimilarity: recall?.minMeaning,
    });
  }

  async function retrieve(
    ctx: Context,
    input: RetrievalInput,
    options: Pick<RetrieveDeps, 'sources' | 'plainClaims'> = {}
  ): Promise<MemoryPage | null> {
    const bounds = retrievalBoundsFor(input.purpose);
    return bounds === null ? null : retrieveQuery(ctx, memoryQueryFor(input, bounds), options);
  }

  /**
   * Issues an execution context for one turn, session or wake (scope.ts#issueContext); its row is written deferred.
   */
  function issueContext(spec: Parameters<typeof issuePureContext>[0] = {}): Context {
    const ctx = linkedContext(issuePureContext({ ...spec, now }), handle ? database() : null);
    if (!handle || closing) return ctx;
    const update = { kind: 'context', context: contextRow(ctx) };
    defer(() => {
      if (!handle || closing) return;
      const done = engine
        ? engine.dead
          ? null
          : engine.call('memoryWrite', { update })
        : Promise.resolve().then(() => applyMemoryWrite(opened(), update));
      done?.catch((error: unknown) => log.warn('memory db: context record failed', { code: codeOf(error) }));
    });
    return ctx;
  }

  /** The state for the status card: whether it is open, its units and rows, the observations, her session. */
  function status(): MemoryDbStatus {
    const current = handle;
    const open = current !== null;
    let rows: number | null = null;
    let files: number | null = null;
    if (current !== null) {
      try {
        files = dbOf(current).prepare('SELECT COUNT(*) AS n FROM files WHERE gone_at IS NULL').get()?.n as number;
        rows = 0;
        for (const table of [
          'sources',
          'claims',
          'episodes',
          'descriptions',
          'places',
          'people',
          'day',
          'selfreflection',
        ]) {
          rows += dbOf(current).prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NULL`).get()
            ?.n as number;
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
      observe: { queued: observeQueue.length, writing: observing.size, dropped: observeDropped },
      session: {
        running: sessionRun !== null,
        lastAt: sessionState.lastAt,
        lastOutcome: sessionState.lastOutcome,
        lastFailure: sessionState.lastFailure,
        reviewsFailedToday: sessionState.reviewFailDay === utcDay(now()) ? sessionState.reviewFails : 0,
      },
      pending: quarantineStatus(quarantineDir),
    };
  }

  /** Shutdown: waits for the jobs under way, writes what waits, closes the database, releases the lock. */
  async function close() {
    closing = true;
    const { closeMs } = settings();
    const deadline = performance.now() + closeMs;
    await stopReader(closeMs);
    await waitFor(selfreflectionJob.stop(), closeMs);
    await waitFor(focusRun, Math.max(0, deadline - performance.now()));
    await waitFor(indexRun, Math.max(0, deadline - performance.now()));
    await waitFor(reembedRun, Math.max(0, deadline - performance.now()));
    await waitFor(mediaEmbedRun, Math.max(0, deadline - performance.now()));
    for (const job of Object.values(embedJobs)) await waitFor(job.run, Math.max(0, deadline - performance.now()));
    await waitFor(projectRun, Math.max(0, deadline - performance.now()));
    await waitFor(sessionRun, Math.max(0, deadline - performance.now()));
    await flushTurnReads(Math.max(0, deadline - performance.now()));
    await flushObservations(Math.max(0, deadline - performance.now()));
    await closeNow(Math.max(0, deadline - performance.now()));
    await Promise.allSettled([...observing]);
    tellDropped();
    closed = true;
  }

  /** The scheduled session look under way, or a resolved promise: its end. */
  const waitSession = () => sessionRun ?? Promise.resolve();

  return {
    namespace: () => iface(),
    open: readyOpen,
    tick,
    database,
    readHandle,
    searchRecord,
    recordTurnReads,
    onAffinityMoves,
    writeUnit,
    writeOperational: (operational: OperationalWrite) => write({ ...operational, kind: 'operational', now: now() }),
    writeIntentions: (intentions: IntentionsWrite) => write({ ...intentions, kind: 'intentions', now: now() }),
    keepPending,
    quarantinedPending: () => quarantinedIn(quarantineDir),
    replayQuarantinedPending,
    recordWake,
    issueContext,
    retrievalBoundsFor,
    retrieveQuery,
    retrieve,
    personLink: (update: Row) => write({ ...update, kind: 'person-link' }),
    personMerge: (update: Row) => write({ ...update, kind: 'person-merge' }),
    personBind: async (input: BindInput, confirm: BindConfirm | null) => {
      const { memoryKeyState } = await import('./session.ts');
      const llm = memoryKeyState(hot.config, sessionEnv(), sessionKeys(), sessionPath()).ok ? sessionLlm() : null;
      const deps = { db: dbOf(opened()), write: memoryWrite, llm, hot, now, selfName: selfName() ?? '' };
      return bindAccount(deps, input, confirm);
    },
    memoryWrite,
    inspection,
    ...privateReads(() => dbOf(opened())),
    observe,
    ...messageWriters(observe),
    waitObservations,
    focusPeople,
    status,
    close,
    waitSession,
  };
}
