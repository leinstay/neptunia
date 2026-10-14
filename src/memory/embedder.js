// The live embedding queue: keeps the meaning index (src/memory/vectors.js) current while the
// bot runs. Every `seen` / `said` line the record takes (src/index.js wraps the record's append,
// so every writer is covered) is queued with its revision; every `embed.flushSeconds` (on the
// caller's tick) or once `embed.batch` lines wait, one embedding request carries a batch of
// chunks (src/memory/chunks.js: the line and the lines before it in the same channel and layer)
// and the vectors are appended to the index. Off unless `features.meaningSearch` and
// `features.embedIndex` are both exactly true (read at each enqueue and flush): nothing is queued
// or sent otherwise.
//
// The context of a chunk comes from a small ring of recent lines per channel and layer, kept in
// memory and filled from the record the first time a channel is flushed. A job is dropped, before
// the request and again before the append, when a newer revision of its message was queued, when
// a member of its chunk is under a forgetting marker or was forgotten (the deletion ledger) after
// the line, when its private layer's member is, or when the record no longer holds its day file
// (a wipe). A context line failing the same check is left out of the chunk. A failed request or
// append keeps the batch for the next flush; the queue holds at most `embed.queueMax` jobs, the
// oldest dropped with a warn. Logs carry counts and guild ids, never text.

import * as nodeFs from 'node:fs/promises';
import { log as defaultLog } from '../log.js';
import { helperModel } from '../behavior/mention.js';
import { EMBED_ROLE } from '../llm/embed.js';
import { railReason } from '../llm/openrouter.js';
import { estimateTokens } from '../llm/tokens.js';
import { CHUNK_CONTEXT_LINES, compareLines, contextFor, embeddableLine, layerChannelKey, recordChunk } from './chunks.js';
import { forgettingIds, isoOf, recordDrops } from './record.js';
import { readLedger } from './store.js';

/** `embed.batch` when missing or invalid: config.json's value. */
const BATCH_FALLBACK = 64;
/** `embed.flushSeconds` when missing or invalid: config.json's value. */
const FLUSH_SECONDS_FALLBACK = 180;
/** `embed.queueMax` when missing or invalid: config.json's value. */
const QUEUE_MAX_FALLBACK = 2000;
/** `llm.maxRequestTokens` when missing: config.json's value. */
const MAX_REQUEST_TOKENS_FALLBACK = 50000;
/** Lines kept per channel ring: enough context for a batch that arrives out of order. */
const RING_SIZE = 16;
/** How far back a ring is filled from the record on first use. */
const WARM_MS = 24 * 60 * 60 * 1000;
/** Message revisions remembered, so a line recorded twice is queued once. */
const LATEST_MAX = 20000;

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
const positiveNumber = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
const revisionOf = (line) => (Number.isInteger(line?.revision) && line.revision > 0 ? line.revision : 1);
const layerOf = (privateUserId) => (typeof privateUserId === 'string' && privateUserId ? privateUserId : null);

/**
 * Create the live embedding queue.
 *
 * @param {object} deps
 * @param {{ config: object }} deps.hot  The live config, read at the moment of use.
 * @param {{ append: Function }} deps.vectors  src/memory/vectors.js#createVectors
 * @param {(texts: string[], opts: object) => Promise<Float32Array[]>} deps.embed  src/llm/embed.js's `embed`
 * @param {{ iterate: Function, dayFile: Function }} deps.record  The record (unwrapped): rings are filled from it.
 * @param {string} deps.dataDir  The `data/` directory: forgetting markers and the deletion ledger.
 * @param {{ info: Function, warn: Function }} [deps.log]
 * @param {() => number} [deps.now]
 * @param {object} [deps.fs]  A `node:fs/promises`-shaped API.
 * @param {(guildId: string, userId: string) => string|null} [deps.nameOf]  A member's display name now.
 * @param {(guildId: string) => string} [deps.selfName]  The persona's display name.
 * @returns {{
 *   enqueue(guildId: string, lines: object[], opts?: { privateUserId?: string|null }): number,
 *   flush(): Promise<{ embedded: number, dropped: number, left: number }>,
 *   tick(): Promise<object>|null,
 *   stats(): { queued: number, rings: number },
 * }}
 *   `enqueue` (synchronous) queues each embeddable line not queued before at its revision (an
 *   older revision still waiting is replaced) and returns how many it queued; a full batch starts a
 *   flush in the background. `flush` sends at most one request (the oldest jobs, up to
 *   `embed.batch` and within `llm.maxRequestTokens`) and appends what survives the checks; one
 *   flush runs at a time. `tick` flushes once `embed.flushSeconds` have passed since the last one.
 */
export function createEmbedder({ hot, vectors, embed, record, dataDir, log = defaultLog, now = Date.now, fs = nodeFs, nameOf = null, selfName = null }) {
  let queue = [];
  const rings = new Map(); // `${guildId}|${layerChannelKey}` -> { lines, warmed }
  const latest = new Map(); // `${guildId}|${layer}|${messageId}` -> newest revision queued
  let lastFlushAt = now();
  let flushing = null;

  const on = () => hot.config?.features?.meaningSearch === true && hot.config?.features?.embedIndex === true;

  function settings() {
    const embedConfig = hot.config?.embed ?? {};
    return {
      batch: positiveInt(embedConfig.batch, BATCH_FALLBACK),
      flushSeconds: positiveNumber(embedConfig.flushSeconds, FLUSH_SECONDS_FALLBACK),
      queueMax: positiveInt(embedConfig.queueMax, QUEUE_MAX_FALLBACK),
      maxTokens: positiveNumber(hot.config?.llm?.maxRequestTokens, MAX_REQUEST_TOKENS_FALLBACK),
    };
  }

  const ringKey = (guildId, privateUserId, channelId) => `${guildId}|${layerChannelKey(privateUserId ?? '', channelId)}`;
  const channelOf = (line) => (typeof line?.scope?.channel === 'string' && line.scope.channel ? line.scope.channel : null);

  function ringOf(key) {
    let ring = rings.get(key);
    if (!ring) {
      ring = { lines: [], warmed: false };
      rings.set(key, ring);
    }
    return ring;
  }

  /** Put `line` in its ring (a newer revision replaces an older one), the ring kept to its size. */
  function ringAdd(ring, line) {
    const at = ring.lines.findIndex((other) => other.messageId === line.messageId);
    if (at >= 0) {
      if (revisionOf(ring.lines[at]) > revisionOf(line)) return;
      ring.lines.splice(at, 1);
    }
    ring.lines.push(line);
    ring.lines.sort(compareLines);
    if (ring.lines.length > RING_SIZE) ring.lines.splice(0, ring.lines.length - RING_SIZE);
  }

  function remember(idKey, revision) {
    latest.delete(idKey);
    latest.set(idKey, revision);
    if (latest.size > LATEST_MAX) latest.delete(latest.keys().next().value);
  }

  function enqueue(guildId, lines, { privateUserId = null } = {}) {
    if (!on()) return 0;
    const { batch, queueMax } = settings();
    const layer = layerOf(privateUserId);
    let added = 0;
    for (const raw of Array.isArray(lines) ? lines : []) {
      if (!embeddableLine(raw)) continue;
      const line = { ...raw, occurredAt: isoOf(raw.occurredAt) ?? new Date(now()).toISOString() };
      const revision = revisionOf(line);
      const idKey = `${guildId}|${layer ?? ''}|${line.messageId}`;
      if (latest.get(idKey) >= revision) continue;
      remember(idKey, revision);
      queue = queue.filter((job) => job.idKey !== idKey);
      const key = ringKey(String(guildId), layer, channelOf(line));
      ringAdd(ringOf(key), line);
      queue.push({ guildId: String(guildId), privateUserId: layer, line, revision, idKey, ringKey: key });
      added += 1;
    }
    if (queue.length > queueMax) {
      const dropped = queue.length - queueMax;
      queue.splice(0, dropped);
      log.warn('embedder: queue full', { dropped, queued: queue.length });
    }
    if (queue.length >= batch && !flushing) {
      flush().catch((error) => log.warn('embedder: flush failed', { code: error?.code ?? null, name: error?.name ?? null }));
    }
    return added;
  }

  /** Fill the rings of `jobs` not yet filled, from the record, one pass per guild and layer. */
  async function warm(jobs) {
    const groups = new Map();
    for (const job of jobs) {
      const ring = ringOf(job.ringKey);
      if (ring.warmed) continue;
      const key = `${job.guildId}|${job.privateUserId ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        group = { guildId: job.guildId, privateUserId: job.privateUserId, channels: new Set(), from: Infinity, to: -Infinity };
        groups.set(key, group);
      }
      group.channels.add(channelOf(job.line));
      const at = Date.parse(job.line.occurredAt);
      group.from = Math.min(group.from, at);
      group.to = Math.max(group.to, at);
    }
    for (const group of groups.values()) {
      const channelIds = [...group.channels].filter(Boolean);
      try {
        if (channelIds.length > 0 && Number.isFinite(group.from)) {
          const query = {
            from: new Date(group.from - WARM_MS).toISOString(),
            to: new Date(group.to).toISOString(),
            channelIds,
            privateUserId: group.privateUserId,
          };
          for await (const line of record.iterate(group.guildId, query)) {
            if (!embeddableLine(line)) continue;
            ringAdd(ringOf(ringKey(group.guildId, group.privateUserId, channelOf(line))), line);
          }
        }
      } catch (error) {
        log.warn('embedder: warm failed', { guildId: group.guildId, code: error?.code ?? null });
      }
      for (const channelId of group.channels) ringOf(ringKey(group.guildId, group.privateUserId, channelId)).warmed = true;
    }
  }

  /** What a guild's forgets say now: the ids under a marker and each forgotten member's latest ledger time. */
  async function forgetsOf(guildId, cache) {
    if (cache.has(guildId)) return cache.get(guildId);
    const hidden = await forgettingIds(fs, dataDir, guildId);
    const ledger = new Map();
    for (const entry of readLedger(dataDir, guildId)) {
      const at = Date.parse(entry.at);
      if (Number.isFinite(at) && !(ledger.get(entry.userId) >= at)) ledger.set(entry.userId, at);
    }
    const value = { hidden, ledger };
    cache.set(guildId, value);
    return value;
  }

  /** Whether forgetting leaves `value` (a record line or a row's meta) out. */
  function forgotten(value, { hidden, ledger }) {
    for (const id of hidden) if (recordDrops(value, id)) return true;
    for (const [id, at] of ledger) if (recordDrops(value, id, at)) return true;
    return false;
  }

  /** Whether the private layer of a job is gone or going: its member under a marker or forgotten after the line. */
  function layerForgotten(job, { hidden, ledger }) {
    if (!job.privateUserId) return false;
    if (hidden.has(job.privateUserId)) return true;
    const at = ledger.get(job.privateUserId);
    return at !== undefined && !(Date.parse(job.line.occurredAt) >= at);
  }

  /** Whether the record still holds the job's day file (a wipe deletes it). */
  async function dayFileHeld(job, cache) {
    const file = record.dayFile(job.guildId, job.line.occurredAt, job.privateUserId);
    if (!cache.has(file)) {
      let held = true;
      try {
        await fs.stat(file);
      } catch (error) {
        if (error?.code === 'ENOENT') held = false;
      }
      cache.set(file, held);
    }
    return cache.get(file);
  }

  /** Whether a job (with its chunk's meta) is still to be appended. */
  async function stillWanted(job, meta, caches) {
    if (latest.get(job.idKey) !== job.revision) return false;
    const forgets = await forgetsOf(job.guildId, caches.forgets);
    if (layerForgotten(job, forgets) || forgotten(meta, forgets)) return false;
    return dayFileHeld(job, caches.files);
  }

  /** The chunk of a job: its line with the context lines no forget leaves out. */
  async function chunkOf(job, caches) {
    const forgets = await forgetsOf(job.guildId, caches.forgets);
    const context = contextFor(job.line, ringOf(job.ringKey).lines, RING_SIZE)
      .filter((line) => !forgotten(line, forgets))
      .slice(-CHUNK_CONTEXT_LINES);
    return recordChunk(job.line, context, {
      nameOf: (id) => (typeof nameOf === 'function' ? nameOf(job.guildId, id) : null),
      selfName: typeof selfName === 'function' ? selfName(job.guildId) ?? '' : '',
    });
  }

  /** Take the ring lines a forget leaves out away from memory. */
  async function purgeRings(caches) {
    for (const [key, ring] of rings) {
      const guildId = key.slice(0, key.indexOf('|'));
      const forgets = await forgetsOf(guildId, caches.forgets);
      if (forgets.hidden.size === 0 && forgets.ledger.size === 0) continue;
      ring.lines = ring.lines.filter((line) => !forgotten(line, forgets));
    }
  }

  async function runFlush() {
    lastFlushAt = now();
    if (!on() || queue.length === 0) return { embedded: 0, dropped: 0, left: queue.length };
    const { batch, maxTokens } = settings();
    const config = hot.config;
    const caches = { forgets: new Map(), files: new Map() };
    const taken = queue.slice(0, batch);
    await warm(taken);
    await purgeRings(caches);

    // The checks before anything is sent: a forgotten or superseded line never leaves the machine.
    const jobs = [];
    const gone = new Set();
    let tokens = 0;
    for (const job of taken) {
      const chunk = await chunkOf(job, caches);
      if (!(await stillWanted(job, chunk.meta, caches))) {
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
      if (gone.size > 0) log.info('embedder: flushed', { embedded: 0, dropped: gone.size, left: queue.length });
      return { embedded: 0, dropped: gone.size, left: queue.length };
    }

    let vectorsOut;
    try {
      vectorsOut = await embed(jobs.map(({ chunk }) => chunk.text), { config });
    } catch (error) {
      log.warn('embedder: embed failed', { lines: jobs.length, reason: railReason(error, 'embed-error'), status: error?.statusCode ?? null, left: queue.length });
      return { embedded: 0, dropped: gone.size, left: queue.length };
    }
    const sent = new Set(jobs.map(({ job }) => job));
    queue = queue.filter((job) => !sent.has(job));

    // The checks again: a forget or an edit may have landed while the request ran.
    const groups = new Map();
    let dropped = gone.size;
    const fresh = { forgets: new Map(), files: new Map() };
    for (let i = 0; i < jobs.length; i += 1) {
      const { job, chunk } = jobs[i];
      if (!(await stillWanted(job, chunk.meta, fresh))) {
        dropped += 1;
        continue;
      }
      const key = `${job.guildId}|${job.privateUserId ?? ''}`;
      if (!groups.has(key)) groups.set(key, { guildId: job.guildId, privateUserId: job.privateUserId, rows: [], jobs: [] });
      groups.get(key).rows.push({ meta: chunk.meta, vector: vectorsOut[i] });
      groups.get(key).jobs.push(job);
    }
    const model = helperModel(config, { role: EMBED_ROLE }) ?? null;
    let embedded = 0;
    for (const group of groups.values()) {
      try {
        await vectors.append(group.guildId, group.rows, { privateUserId: group.privateUserId, model });
        embedded += group.rows.length;
      } catch (error) {
        // Kept for the next flush: the jobs go back to the front of the queue.
        queue = [...group.jobs, ...queue];
        log.warn('embedder: append failed', { guildId: group.guildId, rows: group.rows.length, code: error?.code ?? null });
      }
    }
    log.info('embedder: flushed', { embedded, dropped, left: queue.length });
    return { embedded, dropped, left: queue.length };
  }

  function flush() {
    if (!flushing) {
      flushing = runFlush().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  function tick() {
    if (now() - lastFlushAt < settings().flushSeconds * 1000) return null;
    return flush();
  }

  function stats() {
    return { queued: queue.length, rings: rings.size };
  }

  return { enqueue, flush, tick, stats };
}
