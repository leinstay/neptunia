// The live embedding queue: keeps the meaning index (src/memory/vectors.ts) current while the
// bot runs. Every `seen` / `said` line the record takes (src/index.js wraps the record's append,
// so every writer is covered) is queued with its revision; every `FLUSH_SECONDS` (on the
// caller's tick) or once `BATCH` lines wait, one embedding request carries a batch of
// chunks (src/memory/chunks.ts: the line and the lines before it in the same channel and layer)
// and the vectors are appended to the index. Off unless `features.meaningSearch` and
// `features.embedIndex` are both exactly true (read at each enqueue and flush): nothing is queued
// or sent otherwise.
//
// The context of a chunk comes from a small ring of recent lines per channel and layer, kept in
// memory and filled from the record the first time a channel is flushed. A job is dropped, before
// the request and again before the append, when a newer revision of its message was queued. A
// failed request or append keeps the batch for the next flush; the queue holds at most `QUEUE_MAX` jobs, the
// oldest dropped with a warn. On shutdown `close` flushes once more, briefly, and stops the queue.
//
// The catch-up keeps the index whole across every gap the queue cannot see (a stop, a crash, a
// pause, the switches turned on late, a line the queue dropped): `catchUp` reads the record of the
// last `CATCH_UP_HOURS` in the place, takes each message's newest
// revision, and queues every message whose
// `record:<id>:<revision>` the index does not hold (src/memory/vectors.ts#has), with its channel
// context from the same read, at most up to `QUEUE_MAX`; the rest goes on a later pass, run
// once the queue has drained. A pass runs when the caller starts it (the start, `/nep resume`),
// on the tick when the switches turn on, and every `CATCH_UP_EVERY_MINUTES`; never while the
// bot is paused. Each pass logs its coverage (counts), and warns when a message the queue had
// taken is missing with nothing left to send it (lost). Logs carry counts and place ids, never text.

import { recordHolders } from './db/record-lines.ts';
import { log as defaultLog } from '../log.ts';
import { roleModel } from '../llm/roles.ts';
import { EMBED_ROLE } from '../llm/embed.ts';
import { railReason } from '../llm/openrouter.ts';
import { estimateTokens } from '../llm/tokens.ts';
import { HOUR_MS, MINUTE_MS } from '../time.ts';
import {
  CHUNK_CONTEXT_LINES,
  chunkKey,
  compareLines,
  contextFor,
  embeddableLine,
  newestRevisions,
  recordChunk,
} from './chunks.ts';
import { isoOf, asRecordLines } from './record.ts';
import type { createRecord, RecordLine } from './record.ts';
import type { createVectors } from './vectors.ts';

import { propOf, isFiniteNumber, isIntegerNumber, readSeamOf } from './types.ts';
import type { Hot, MemoryDb, Untyped } from './types.ts';

// The embedding queue's measures. Production values, config cut of 2026-10-31.
/** The lines one embedding request carries. */
const BATCH = 64;
/** How often the queue flushes, in seconds. */
const FLUSH_SECONDS = 180;
/** The jobs the queue holds. */
const QUEUE_MAX = 2000;
/** How far back a catch-up pass reads, in hours. */
const CATCH_UP_HOURS = 72;
/** How often a catch-up pass runs, in minutes. */
const CATCH_UP_EVERY_MINUTES = 60;
/** `llm.maxRequestTokens` when missing: config.json's value. */
const MAX_REQUEST_TOKENS_FALLBACK = 50000;
/** Lines kept per channel ring: enough context for a batch that arrives out of order. */
const RING_SIZE = 16;
/** How far back a ring is filled from the record on first use (and a catch-up reads for context). */
const WARM_MS = 24 * HOUR_MS;
/** Message revisions remembered, so a line recorded twice is queued once. */
const LATEST_MAX = 20000;
/** How long `close` waits for its one flush on shutdown before it gives up. */
const CLOSE_TIMEOUT_MS = 5000;

const positiveNumber = (value: Untyped, fallback: Untyped) =>
  typeof value === 'number' && isFiniteNumber(value) && value > 0 ? value : fallback;
const revisionOf = (line: Pick<RecordLine, 'revision'> | null | undefined): number =>
  isIntegerNumber(line?.revision) && line.revision > 0 ? line.revision : 1;

/** What a survey of the record finds: the messages read, the ones indexed and the ones still missing. */
type Survey = {
  messages: number;
  indexed: number;
  missing: Array<{ line: Untyped; context: Array<Untyped> | null }>;
};

/** The counts of a catch-up pass, one place's or all of them. */
type PassTotal = Record<(typeof PASS_COUNTS)[number], number> & { oldestMissing: string | null };
const PASS_COUNTS = ['messages', 'indexed', 'missing', 'queued', 'waiting', 'left', 'lost'] as const;

/** `total` with the counts of `pass` added; a pass that did not run leaves it as it is. */
function addPass(total: PassTotal | null, pass: PassTotal | null): PassTotal | null {
  if (!pass) return total;
  const sum: PassTotal = total ?? {
    messages: 0,
    indexed: 0,
    missing: 0,
    queued: 0,
    waiting: 0,
    left: 0,
    lost: 0,
    oldestMissing: null,
  };
  for (const key of PASS_COUNTS) sum[key] += pass[key];
  const oldest = pass.oldestMissing;
  if (oldest && (!sum.oldestMissing || Date.parse(oldest) < Date.parse(sum.oldestMissing))) sum.oldestMissing = oldest;
  return sum;
}

/** One line waiting to be embedded, with the ring it joins and the lines before it (a catch-up job carries its own). */
type Job = {
  placeId: string;
  line: RecordLine;
  revision: number;
  idKey: string;
  ringKey: string;
  context?: Array<RecordLine> | null;
};

/** The latest lines of one chat of a place, kept as the context of the next line there. */
type Ring = { lines: Array<RecordLine>; warmed: boolean };

/** The span of record to read for the jobs of one place whose rings are not filled yet. */
type WarmGroup = {
  placeId: string;
  channels: Set<string | null>;
  from: number;
  to: number;
};

type EmbedderDeps = {
  hot: Pick<Hot, 'config'>;
  vectors: ReturnType<typeof createVectors>;
  embed: (texts: Array<string>, opts: Untyped) => Promise<Array<Float32Array>>;
  record: ReturnType<typeof createRecord>;
  log?: { info: Untyped; warn: Untyped };
  now?: () => number;
  nameOf?: ((placeId: string, accountId: string) => string | null) | null;
  selfName?: ((placeId: string) => string) | null;
  paused?: () => boolean;
  memoryDb: MemoryDb | null;
};

/** Put `line` in its ring (a newer revision replaces an older one), the ring kept to its size. */
function ringAdd(ring: Ring, line: RecordLine) {
  const at = ring.lines.findIndex((other) => other.messageId === line.messageId);
  if (at >= 0) {
    if (revisionOf(ring.lines[at]) > revisionOf(line)) return;
    ring.lines.splice(at, 1);
  }
  ring.lines.push(line);
  ring.lines.sort(compareLines);
  if (ring.lines.length > RING_SIZE) ring.lines.splice(0, ring.lines.length - RING_SIZE);
}

/** The earliest `occurredAt` among missing messages, or null. */
function oldestOf(missing: Untyped) {
  let oldest = null;
  for (const { line } of missing)
    if (oldest === null || Date.parse(line.occurredAt) < Date.parse(oldest)) oldest = isoOf(line.occurredAt);
  return oldest;
}

/**
 * Create the live embedding queue.
 *
 * @param deps.hot  The live config, read at the moment of use.
 * @param deps.vectors  src/memory/vectors.ts#createVectors
 * @param deps.embed  src/llm/embed.ts's `embed`
 * @param deps.record  The record (unwrapped): rings are filled from it.
 * @param [deps.nameOf]  A member's display name now.
 * @param [deps.selfName]  The persona's display name.
 * @param [deps.paused]  Whether the bot is paused (`/nep pause`): no catch-up then.
 * @param deps.memoryDb  The memory database service: the private layers come from it
 *   (src/memory/db/record-lines.ts; a failed read is an error of the pass); the lines come through
 *   `record.iterate`.
 *   `enqueue` (synchronous) queues each embeddable line not queued before at its revision (an
 *   older revision still waiting is replaced) and returns how many it queued; a full batch starts a
 *   flush in the background. `flush` sends at most one request (the oldest jobs, up to
 *   `BATCH` and within `llm.maxRequestTokens`) and appends what survives the checks; one
 *   flush runs at a time. `tick` flushes once `FLUSH_SECONDS` have passed since the last one;
 *   with `placeId` it first runs a catch-up pass when one is due (the switches just turned on, the
 *   first tick, `CATCH_UP_EVERY_MINUTES` since the last pass, or a pass that left messages
 *   behind and a drained queue); null when it did nothing. `catchUp` runs one pass (one at a time:
 *   a second call shares the running one) and resolves `{ messages, indexed, missing, queued,
 *   waiting, left, lost, oldestMissing }` (`waiting`: missing but already queued or in flight;
 *   `left`: no room in the queue this pass; `lost`: missing although the queue had taken them),
 *   or null when the index is off, the bot is paused, the queue closed or the index has no `has`.
 *   `coverage` reads the same window (`hours`, default `CATCH_UP_HOURS`) without queueing,
 *   whatever the switches say. `indexSummary`: the rows of the place's index and the missing count of
 *   the place's last pass (null before one). `close` (shutdown)
 *   flushes once, waiting at most `timeoutMs` (default 5000), and resolves its counts, or null on
 *   the timeout, a failure or a second call; after it nothing is queued.
 */
export function createEmbedder({
  hot,
  vectors,
  embed,
  record,
  log = defaultLog,
  now = Date.now,
  nameOf = null,
  selfName = null,
  paused = () => false,
  memoryDb = null,
}: EmbedderDeps): {
  enqueue(placeId: string, lines: Array<RecordLine>): number;
  flush(): Promise<{ embedded: number; dropped: number; left: number }>;
  tick(placeId?: string | null): Promise<Untyped> | null;
  catchUp(placeId?: string | null): Promise<object | null>;
  coverage(
    placeId: string,
    opts?: { hours?: number }
  ): Promise<{ messages: number; indexed: number; missing: number; oldestMissing: string | null }>;
  indexSummary(placeId: string): Promise<{ rows: number; missing: number | null }>;
  close(opts?: { timeoutMs?: number }): Promise<{ embedded: number; dropped: number; left: number } | null>;
  stats(): { queued: number; rings: number };
} {
  const seam = readSeamOf(memoryDb, log, 'embedder');
  let queue: Array<Job> = [];
  const rings = new Map<string, Ring>(); // `${placeId}|${chat}` -> { lines, warmed }
  const latest = new Map<string, number>(); // `${placeId}|${messageId}` -> newest revision queued
  let lastFlushAt = now();
  let flushing: Untyped = null;
  let closed = false;
  // The catch-up: the pass running, when the last one ran, whether it left messages behind, the
  // switches as the last tick saw them, the jobs of the flush in flight, the jobs appended while
  // a pass ran, and each place's last pass.
  let catching: Untyped = null;
  let lastCatchUpAt: number | null = null;
  let behind = false;
  let wasOn = false;
  let inFlight = new Set();
  let appendedDuringPass: Untyped = null;
  const lastPass = new Map();

  const on = () => true;
  const isPaused = () => typeof paused === 'function' && paused() === true;
  const jobKey = (idKey: string, revision: number) => `${idKey}#${revision}`;

  function settings() {
    return {
      batch: BATCH,
      flushSeconds: FLUSH_SECONDS,
      queueMax: QUEUE_MAX,
      maxTokens: positiveNumber(hot.config?.llm?.maxRequestTokens, MAX_REQUEST_TOKENS_FALLBACK),
      catchUpHours: CATCH_UP_HOURS,
      catchUpEveryMinutes: CATCH_UP_EVERY_MINUTES,
    };
  }

  const ringKey = (placeId: string, channel: string | null) => `${placeId}|${channel ?? ''}`;
  const channelOf = (line: RecordLine) =>
    typeof line?.scope?.channel === 'string' && line.scope.channel ? line.scope.channel : null;

  function ringOf(key: string): Ring {
    let ring = rings.get(key);
    if (!ring) {
      ring = { lines: [], warmed: false };
      rings.set(key, ring);
    }
    return ring;
  }

  function remember(idKey: string, revision: number) {
    latest.delete(idKey);
    latest.set(idKey, revision);
    if (latest.size > LATEST_MAX) {
      const oldest = latest.keys().next().value;
      if (oldest !== undefined) latest.delete(oldest);
    }
  }

  function enqueue(placeId: string, lines: Array<RecordLine>) {
    if (closed || !on()) return 0;
    const { batch, queueMax } = settings();
    let added = 0;
    for (const raw of Array.isArray(lines) ? lines : []) {
      if (!embeddableLine(raw)) continue;
      const line = { ...raw, occurredAt: isoOf(raw.occurredAt) ?? new Date(now()).toISOString() };
      const revision = revisionOf(line);
      const idKey = `${placeId}|${line.messageId}`;
      if ((latest.get(idKey) ?? 0) >= revision) continue;
      remember(idKey, revision);
      queue = queue.filter((job) => job.idKey !== idKey);
      const key = ringKey(String(placeId), channelOf(line));
      ringAdd(ringOf(key), line);
      queue.push({ placeId: String(placeId), line, revision, idKey, ringKey: key });
      added += 1;
    }
    if (queue.length > queueMax) {
      const dropped = queue.length - queueMax;
      queue.splice(0, dropped);
      log.warn('embedder: queue full', { dropped, queued: queue.length });
    }
    kick(batch);
    return added;
  }

  /** A full batch starts a flush in the background. */
  function kick(batch: Untyped) {
    if (queue.length >= batch && !flushing) {
      flush().catch((error: Untyped) =>
        log.warn('embedder: flush failed', { code: error?.code ?? null, name: error?.name ?? null })
      );
    }
  }

  /** Fill the rings of `jobs` not yet filled, from the record, one pass per place. */
  async function warm(jobs: Array<Job>) {
    const groups = new Map<string, WarmGroup>();
    for (const job of jobs) {
      // A catch-up job carries its context from the pass's own read.
      if (job.context) continue;
      const ring = ringOf(job.ringKey);
      if (ring.warmed) continue;
      const key = job.placeId;
      let group = groups.get(key);
      if (!group) {
        group = {
          placeId: job.placeId,
          channels: new Set(),
          from: Infinity,
          to: -Infinity,
        };
        groups.set(key, group);
      }
      group.channels.add(channelOf(job.line));
      const at = Date.parse(job.line.occurredAt);
      group.from = Math.min(group.from, at);
      group.to = Math.max(group.to, at);
    }
    for (const group of groups.values()) {
      const placeIds = [...group.channels].filter((id): id is string => Boolean(id));
      try {
        if (placeIds.length > 0 && isFiniteNumber(group.from)) {
          const query = {
            from: new Date(group.from - WARM_MS).toISOString(),
            to: new Date(group.to).toISOString(),
            placeIds,
          };
          for await (const line of asRecordLines(record.iterate(group.placeId, query))) {
            if (!embeddableLine(line)) continue;
            ringAdd(ringOf(ringKey(group.placeId, channelOf(line))), line);
          }
        }
      } catch (error) {
        log.warn('embedder: warm failed', { placeId: group.placeId, code: propOf(error, 'code') ?? null });
      }
      for (const placeId of group.channels) ringOf(ringKey(group.placeId, placeId)).warmed = true;
    }
  }

  /** Whether a job is still to be appended: no newer revision of its message was queued. */
  function stillWanted(job: Job) {
    return latest.get(job.idKey) === job.revision;
  }

  /** The chunk of a job: its line with its context lines. */
  function chunkOf(job: Job) {
    const context = contextFor(job.line, job.context ?? ringOf(job.ringKey).lines, RING_SIZE).slice(
      -CHUNK_CONTEXT_LINES
    );
    return recordChunk(job.line, context, {
      nameOf: (id) => (typeof nameOf === 'function' ? nameOf(job.placeId, id) : null),
      selfName: typeof selfName === 'function' ? (selfName(job.placeId) ?? '') : '',
    });
  }

  async function runFlush() {
    const startedAt = now();
    lastFlushAt = startedAt;
    if (!on() || queue.length === 0) return { embedded: 0, dropped: 0, left: queue.length };
    const { batch, maxTokens } = settings();
    const config = hot.config;
    const taken = queue.slice(0, batch);
    await warm(taken);

    // The check before anything is sent: a superseded line never leaves the machine.
    const jobs = [];
    const gone = new Set();
    let tokens = 0;
    for (const job of taken) {
      const chunk = chunkOf(job);
      if (!stillWanted(job)) {
        gone.add(job);
        continue;
      }
      const cost = estimateTokens(chunk.text);
      if (jobs.length > 0 && tokens + cost > maxTokens) break;
      tokens += cost;
      jobs.push({ job, chunk });
    }
    queue = queue.filter((job) => !gone.has(job));
    if (jobs.length === 0) {
      if (gone.size > 0)
        log.info('embedder: flushed', { embedded: 0, dropped: gone.size, left: queue.length, ms: now() - startedAt });
      return { embedded: 0, dropped: gone.size, left: queue.length };
    }

    // What a catch-up pass must not queue again while this flush still holds it.
    inFlight = new Set(jobs.map(({ job }) => jobKey(job.idKey, job.revision)));
    let vectorsOut;
    try {
      vectorsOut = await embed(
        jobs.map(({ chunk }) => chunk.text),
        { config }
      );
    } catch (error) {
      log.warn('embedder: embed failed', {
        lines: jobs.length,
        reason: railReason(error, 'embed-error'),
        status: propOf(error, 'statusCode') ?? null,
        left: queue.length,
      });
      return { embedded: 0, dropped: gone.size, left: queue.length };
    }
    const sent = new Set(jobs.map(({ job }) => job));
    queue = queue.filter((job) => !sent.has(job));

    // The check again: an edit may have landed while the request ran.
    const groups = new Map();
    let dropped = gone.size;
    for (let i = 0; i < jobs.length; i += 1) {
      const { job, chunk } = jobs[i];
      if (!stillWanted(job)) {
        dropped += 1;
        continue;
      }
      const key = job.placeId;
      if (!groups.has(key)) groups.set(key, { placeId: job.placeId, rows: [], jobs: [] });
      groups.get(key).rows.push({ meta: chunk.meta, vector: vectorsOut[i] });
      groups.get(key).jobs.push(job);
    }
    const model = roleModel(config, EMBED_ROLE) ?? null;
    let embedded = 0;
    for (const group of groups.values()) {
      try {
        await vectors.append(group.placeId, group.rows, { model });
        embedded += group.rows.length;
        if (appendedDuringPass) for (const job of group.jobs) appendedDuringPass.add(jobKey(job.idKey, job.revision));
      } catch (error) {
        // Kept for the next flush: the jobs go back to the front of the queue.
        queue = [...group.jobs, ...queue];
        log.warn('embedder: append failed', {
          placeId: group.placeId,
          rows: group.rows.length,
          code: propOf(error, 'code') ?? null,
        });
      }
    }
    log.info('embedder: flushed', { embedded, dropped, left: queue.length, ms: now() - startedAt });
    return { embedded, dropped, left: queue.length };
  }

  function flush() {
    if (!flushing) {
      flushing = runFlush().finally(() => {
        flushing = null;
        inFlight = new Set();
      });
    }
    return flushing;
  }

  // ---- the catch-up ---------------------------------------------------------------------------

  /** Every place that holds a record. */
  function recordPlaces(): Array<string> {
    const db = seam.db();
    return seam.run(() => recordHolders(db));
  }

  /**
   * The record of the last `hours` against the index: every message (its newest revision)
   * counted, and the missing ones, oldest first, with their
   * channel's earlier lines when `withContext` (read a day further back for that).
   */
  async function survey(placeId: string, hours: Untyped, { withContext = false } = {}) {
    const to = now();
    const from = to - hours * HOUR_MS;
    const out: Survey = { messages: 0, indexed: 0, missing: [] };
    {
      const raw = [];
      const query = {
        from: new Date(from - (withContext ? WARM_MS : 0)).toISOString(),
        to: new Date(to).toISOString(),
      };
      for await (const line of asRecordLines(record.iterate(placeId, query))) raw.push(line);
      const lines = newestRevisions(raw);
      const channels = new Map();
      const months = new Map<string, Set<string>>();
      for (const line of lines) {
        const key = channelOf(line) ?? '';
        if (!channels.has(key)) channels.set(key, []);
        const channelLines = channels.get(key);
        channelLines.push(line);
        if (!(Date.parse(line.occurredAt) >= from)) continue;
        out.messages += 1;
        const month = (isoOf(line.occurredAt) ?? '').slice(0, 7);
        const indexedKeys = months.get(month) ?? (await vectors.has(placeId, month));
        months.set(month, indexedKeys);
        if (indexedKeys.has(chunkKey({ kind: 'record', id: line.messageId, revision: revisionOf(line) }))) {
          out.indexed += 1;
          continue;
        }
        out.missing.push({
          line,
          context: withContext ? channelLines.slice(Math.max(0, channelLines.length - 1 - RING_SIZE), -1) : null,
        });
      }
    }
    return out;
  }

  async function coverage(placeId: string, { hours = null }: { hours?: number | null } = {}) {
    const window = positiveNumber(hours, settings().catchUpHours);
    const found = await survey(String(placeId), window);
    return {
      messages: found.messages,
      indexed: found.indexed,
      missing: found.missing.length,
      oldestMissing: oldestOf(found.missing),
    };
  }

  async function runCatchUp(placeId: string) {
    if (closed || !on() || isPaused() || typeof vectors?.has !== 'function') return null;
    lastCatchUpAt = now();
    wasOn = true;
    const { catchUpHours, queueMax, batch } = settings();
    // A flush appending while the index is read: those messages are not queued again.
    appendedDuringPass = new Set();
    let found;
    try {
      found = await survey(placeId, catchUpHours, { withContext: true });
    } catch (error) {
      appendedDuringPass = null;
      log.warn('embedder: catch-up failed', { placeId, code: propOf(error, 'code') ?? null });
      return null;
    }
    const appendedMeanwhile = appendedDuringPass;
    appendedDuringPass = null;
    if (closed || !on() || isPaused()) return null;

    const queuedNow = new Set(queue.map((job) => jobKey(job.idKey, job.revision)));
    let room = Math.max(0, queueMax - queue.length);
    const counts = { queued: 0, waiting: 0, left: 0, lost: 0 };
    let indexed = found.indexed;
    const missing: Array<Untyped> = [];
    for (const item of found.missing) {
      const revision = revisionOf(item.line);
      const idKey = `${placeId}|${item.line.messageId}`;
      const key = jobKey(idKey, revision);
      if (appendedMeanwhile.has(key)) {
        indexed += 1;
        continue;
      }
      missing.push(item);
      const known = latest.get(idKey);
      if (queuedNow.has(key) || inFlight.has(key) || (known ?? 0) > revision) {
        // Already on its way (or a newer revision is).
        counts.waiting += 1;
        continue;
      }
      if (known === revision) counts.lost += 1;
      if (room === 0) {
        counts.left += 1;
        continue;
      }
      remember(idKey, revision);
      queue = queue.filter((job) => job.idKey !== idKey);
      const line = { ...item.line, occurredAt: isoOf(item.line.occurredAt) };
      queue.push({
        placeId,
        line,
        revision,
        idKey,
        ringKey: ringKey(placeId, channelOf(line)),
        context: item.context,
      });
      room -= 1;
      counts.queued += 1;
    }
    behind = counts.left > 0;
    const pass = {
      messages: found.messages,
      indexed,
      missing: missing.length,
      ...counts,
      oldestMissing: oldestOf(missing),
    };
    lastPass.set(placeId, pass);
    log.info('embedder: coverage', { placeId, ...pass });
    if (counts.lost > 0)
      log.warn('embedder: coverage gap', { placeId, missing: pass.missing, lost: counts.lost, queued: counts.queued });
    kick(batch);
    return pass;
  }

  /** One pass over every place that holds a record: the counts of all of them, null when none ran. */
  async function catchUpAll(): Promise<PassTotal | null> {
    let total: PassTotal | null = null;
    for (const placeId of recordPlaces()) total = addPass(total, await runCatchUp(placeId));
    return total;
  }

  function catchUp(placeId: string | null = null) {
    if (!catching) {
      catching = (placeId === null ? catchUpAll() : runCatchUp(String(placeId))).finally(() => {
        catching = null;
      });
    }
    return catching;
  }

  /** Whether the tick should run a catch-up pass now (the switches read by the caller). */
  function catchUpDue(isOn: Untyped) {
    if (!isOn || closed || catching || isPaused()) return false;
    if (!wasOn || lastCatchUpAt === null) return true;
    if (now() - lastCatchUpAt >= settings().catchUpEveryMinutes * MINUTE_MS) return true;
    return behind && queue.length === 0 && !flushing;
  }

  async function indexSummary(placeId: string) {
    const id = String(placeId);
    let rows = 0;
    if (typeof vectors?.stats === 'function') {
      rows += (await vectors.stats(id)).rows ?? 0;
    }
    return { rows, missing: lastPass.get(id)?.missing ?? null };
  }

  function tick(placeId: string | null = null) {
    const isOn = on();
    const pass = catchUpDue(isOn) ? catchUp(placeId) : null;
    wasOn = isOn;
    const flushDue = () => now() - lastFlushAt >= settings().flushSeconds * 1000;
    if (pass) {
      const logged = pass.catch((error: Untyped) =>
        log.warn('embedder: catch-up failed', { code: error?.code ?? null })
      );
      return logged.then(() => (flushDue() ? flush() : null));
    }
    if (!flushDue()) return null;
    return flush();
  }

  async function close({ timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
    if (closed) return null;
    closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Not unref'd: the wait itself holds the process until the flush or the timeout (cleared below).
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const flushed = flush().catch((error: Untyped) => {
      log.warn('embedder: flush failed', { code: error?.code ?? null, name: error?.name ?? null });
      return null;
    });
    try {
      return await Promise.race([flushed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stats() {
    return { queued: queue.length, rings: rings.size };
  }

  return { enqueue, flush, tick, catchUp, coverage, indexSummary, close, stats };
}
