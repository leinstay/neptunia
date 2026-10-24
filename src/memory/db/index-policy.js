// The index policy and the storage marks (schema v11, spec 2026-10-24-memory-schema-v7, section 7; section 11 on
// vectors and media overrides it): which tier each stored line is in, which vectors are kept, and which media files of
// hers are on disk. No text is ever deleted here, and no vector row: an evicted vector keeps its row, `model`, `dims`,
// `norm`, `scale` and `context`; only its `bytes` are dropped and `evicted_at` is set.
//
//   classify(handle, { now, config, apply, evict })
//       The tier of every source: `a` (hers, addressed to her, in a DM, cited by a claim, a claim version or an
//       episode, pinned, or touched while the touch lasts), `c` (a member of a foreign capture bundle and nothing of
//       `a`), `b` (the rest: lines she saw). Then the vectors, exactly the owner's classes: a vector is kept while its
//       line is newer than `recall.db.vectorDays` (90), or when the line (any revision of its message) is cited, pinned
//       or touched, and always for consolidated memory (an archive item's vector) or a vector whose line is not stored
//       (never judged on what is missing); every other vector is evicted. A dry run (`apply` false) only counts; with
//       `apply` the tiers are written (`index_policy`, `sources.tier`), and with `evict` too the vectors (one
//       transaction). A vector the sync filled again after an eviction (its month file was rewritten) is evicted again.
//   touch(handle, sourceIds, { now, config })
//       A recall window or a session batch reached these lines: each becomes tier `a` with reason `touch` until
//       `recall.db.touchDays` (30) from now, so its vector is re-embedded (the job below) and kept; once the touch has
//       expired the next classification evicts it again.
//   pendingReembed(db, { now, limit })   the evicted vectors of lines whose touch still lasts.
//   reembedTouched({ db, write, embed, config, now, quantize, model, chunkOf, limit })
//       The re-embed job (`recall.db.reembed`): the pending vectors' inputs rebuilt from the stored lines (`chunkOf`,
//       the engine's chunk builder over the line and its context lines as `vectors.context` names them), embedded
//       through the existing embed path (`embed(texts, { config, purpose })`), quantised as the vector files are, and
//       written through `write` (`{ kind: 'reembed', rows, now }`, applyReembed on the writer). A vector of another
//       model than today's embedding model, or of other dims, is left evicted and counted.
//   checkMedia(handle, { dataDir, apply })
//       Her diary media (`media` rows of kind `diary`, files under `data/media/diary/`): `present` when the file exists
//       with the stored size, else `missing`. Every other media row stays `unknown` (foreign media keeps its
//       description and the interface's reference; its hash may be null).
// Every time is an ISO string; `now` is milliseconds. Imports nothing heavy (the sync worker loads it).

import fs from 'node:fs';
import path from 'node:path';
import { SELF_SOURCE_KINDS } from './schema.js';

export const DEFAULT_VECTOR_DAYS = 90;
export const DEFAULT_TOUCH_DAYS = 30;
const DAY_MS = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const nodeOf = (sourceId) => `source:${sourceId}`;
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

/** The policy's numbers from the live config (`recall.db`). */
export function indexSettings(config) {
  const db = config?.recall?.db ?? {};
  return {
    vectorDays: positive(db.vectorDays, DEFAULT_VECTOR_DAYS),
    touchDays: positive(db.touchDays, DEFAULT_TOUCH_DAYS),
    eviction: db.vectorEviction === true,
    reembed: db.reembed === true,
  };
}

const hasTable = (db, name) => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** The ids of every source a claim, a claim version or an episode cites (live links). */
function citedIds(db) {
  const ids = new Set();
  for (const row of db.prepare('SELECT source_id AS id FROM claim_sources WHERE retired_at IS NULL AND source_id IS NOT NULL').iterate()) ids.add(row.id);
  for (const row of db.prepare('SELECT source_id AS id FROM episode_sources WHERE retired_at IS NULL AND source_id IS NOT NULL').iterate()) ids.add(row.id);
  if (hasTable(db, 'claim_version_sources')) for (const row of db.prepare('SELECT source_id AS id FROM claim_version_sources').iterate()) ids.add(row.id);
  return ids;
}

/** The policy rows that hold over a computation: pins, and touches with their expiry. */
function heldPolicy(db) {
  const held = new Map();
  for (const row of db.prepare("SELECT node_id, pinned, reason, expires_at FROM index_policy WHERE pinned = 1 OR reason = 'touch'").iterate()) held.set(row.node_id, { ...row });
  return held;
}

const SELF_KINDS = new Set([...SELF_SOURCE_KINDS, 'said', 'answer']);

/** The tier and the reason of one source row (see the head of this file). */
function tierOf(row, { cited, captured, held, nowIso }) {
  const policy = held.get(nodeOf(row.id));
  if (policy?.pinned === 1) return { tier: 'a', reason: 'pinned' };
  if (policy?.reason === 'touch' && typeof policy.expires_at === 'string' && policy.expires_at > nowIso) return { tier: 'a', reason: 'touch', expires: policy.expires_at };
  if (row.author_kind === 'self' || SELF_KINDS.has(row.kind)) return { tier: 'a', reason: 'self' };
  if (row.direct === 1) return { tier: 'a', reason: 'addressed' };
  if (row.scope_kind === 'dm' || (typeof row.audience_id === 'string' && row.audience_id.startsWith('aud:dm:'))) return { tier: 'a', reason: 'dm' };
  if (cited.has(row.id)) return { tier: 'a', reason: 'cited' };
  if (captured.has(row.id)) return { tier: 'c', reason: 'capture' };
  return { tier: 'b', reason: 'seen' };
}

/**
 * Classifies every source and plans the vectors (see the head of this file).
 * @returns {{ tiers: { a: number, b: number, c: number }, reasons: object, vectors: { kept: object, evict: number, evicted: number, restored: number }, applied: boolean, evictedNow: number }}
 */
export function classify(handle, { now, config = null, apply = false, evict = false } = {}) {
  const db = handle.db ?? handle;
  const settings = indexSettings(config);
  const nowIso = iso(now);
  const cutoff = iso(now - settings.vectorDays * DAY_MS);
  const cited = citedIds(db);
  const captured = new Set(hasTable(db, 'capture_members') ? db.prepare('SELECT DISTINCT source_id AS id FROM capture_members').all().map((row) => row.id) : []);
  const held = heldPolicy(db);
  const tiers = { a: 0, b: 0, c: 0 };
  const reasons = {};
  const decided = new Map();
  // A message is cited, pinned or touched when any of its revisions is.
  const keptMessages = new Map();
  for (const row of db.prepare('SELECT id, kind, author_kind, direct, scope_kind, audience_id, authority_id, native_id FROM sources WHERE id IS NOT NULL').iterate()) {
    const tier = tierOf(row, { cited, captured, held, nowIso });
    decided.set(row.id, tier);
    tiers[tier.tier] += 1;
    reasons[tier.reason] = (reasons[tier.reason] ?? 0) + 1;
    if (['cited', 'pinned', 'touch'].includes(tier.reason) && row.native_id) keptMessages.set(`${row.authority_id ?? ''}\u0000${row.native_id}`, tier.reason);
  }
  const plan = [];
  const kept = { recent: 0, cited: 0, pinned: 0, touch: 0, consolidated: 0, unlinked: 0 };
  let evicted = 0;
  for (const row of db.prepare(`SELECT v.rowid AS rowid, v.chunk_key AS chunk_key, v.evicted_at AS evicted_at, v.bytes IS NULL AS empty,
      s.id AS source_id, s.occurred_at AS occurred_at, s.recorded_at AS recorded_at, s.authority_id AS authority_id, s.native_id AS native_id
    FROM vectors v LEFT JOIN sources s ON s.rowid = v.source_rowid WHERE v.retired_at IS NULL`).iterate()) {
    let keep = null;
    if (/^(?:private:[^:]+:)?archive:/.test(String(row.chunk_key ?? ''))) keep = 'consolidated';
    else if (!row.source_id) keep = 'unlinked';
    else if ((row.occurred_at ?? row.recorded_at ?? '') >= cutoff) keep = 'recent';
    else {
      const reason = decided.get(row.source_id)?.reason;
      keep = ['cited', 'pinned', 'touch'].includes(reason) ? reason : (keptMessages.get(`${row.authority_id ?? ''}\u0000${row.native_id}`) ?? null);
    }
    if (keep) {
      kept[keep] += 1;
      if (row.evicted_at && !row.empty) plan.push({ rowid: row.rowid, action: 'clear' });
      continue;
    }
    if (row.evicted_at && row.empty) { evicted += 1; continue; }
    plan.push({ rowid: row.rowid, action: 'evict' });
  }
  const toEvict = plan.filter((entry) => entry.action === 'evict').length;
  let evictedNow = 0;
  if (apply) {
    const write = () => {
      const upsert = db.prepare(`INSERT INTO index_policy (node_id, tier, reason, pinned, evaluated_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET tier = excluded.tier, reason = excluded.reason, evaluated_at = excluded.evaluated_at,
          expires_at = CASE WHEN excluded.reason = 'touch' THEN index_policy.expires_at ELSE NULL END`);
      const setTier = db.prepare('UPDATE sources SET tier = ? WHERE id = ? AND tier IS NOT ?');
      for (const [id, tier] of decided) {
        upsert.run(nodeOf(id), tier.tier, tier.reason, nowIso, tier.expires ?? null);
        setTier.run(tier.tier, id, tier.tier);
      }
      if (evict) {
        const drop = db.prepare('UPDATE vectors SET bytes = NULL, evicted_at = COALESCE(evicted_at, ?) WHERE rowid = ?');
        const clear = db.prepare('UPDATE vectors SET evicted_at = NULL WHERE rowid = ? AND bytes IS NOT NULL');
        for (const entry of plan) {
          if (entry.action === 'evict') evictedNow += drop.run(nowIso, entry.rowid).changes;
          else clear.run(entry.rowid);
        }
      }
    };
    if (typeof handle.transaction === 'function') handle.transaction(write);
    else write();
  }
  return { tiers, reasons, vectors: { kept, evict: toEvict, evicted }, applied: apply === true, evictedNow };
}

/**
 * Marks `sourceIds` touched (tier `a`, reason `touch`) until `recall.db.touchDays` from `now`; a pin is kept.
 * @returns {number}  how many were marked
 */
export function touch(handle, sourceIds, { now, config = null } = {}) {
  const { touchDays } = indexSettings(config);
  const nowIso = iso(now);
  const expires = iso(now + touchDays * DAY_MS);
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).filter((id) => typeof id === 'string' && id))];
  return handle.transaction(() => {
    const { db } = handle;
    const upsert = db.prepare(`INSERT INTO index_policy (node_id, tier, reason, pinned, evaluated_at, expires_at) VALUES (?, 'a', 'touch', 0, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET tier = 'a', reason = 'touch', evaluated_at = excluded.evaluated_at, expires_at = excluded.expires_at`);
    let count = 0;
    for (const id of ids) {
      if (!db.prepare('SELECT 1 AS ok FROM sources WHERE id = ?').get(id)) continue;
      upsert.run(nodeOf(id), nowIso, expires);
      db.prepare("UPDATE sources SET tier = 'a' WHERE id = ?").run(id);
      count += 1;
    }
    return count;
  });
}

/** The evicted vectors of lines whose touch still lasts, oldest touch first. */
export function pendingReembed(db, { now, limit = 100 } = {}) {
  return db.prepare(`SELECT v.rowid AS rowid, v.chunk_key AS chunk_key, v.model AS model, v.dims AS dims, v.context AS context, s.id AS source_id
    FROM vectors v JOIN sources s ON s.rowid = v.source_rowid JOIN index_policy p ON p.node_id = 'source:' || s.id
    WHERE v.bytes IS NULL AND v.retired_at IS NULL AND p.reason = 'touch' AND p.expires_at > ?
    ORDER BY p.evaluated_at, v.rowid LIMIT ?`).all(iso(now), Math.max(1, limit)).map((row) => ({ ...row }));
}

/** Writes re-embedded vectors (`[{ rowid, bytes, scale, norm }]`) on the writer; only a row still evicted is filled. */
export function applyReembed(handle, { rows }) {
  return handle.transaction(() => {
    const fill = handle.db.prepare('UPDATE vectors SET bytes = ?, scale = ?, norm = ?, evicted_at = NULL WHERE rowid = ? AND bytes IS NULL');
    let written = 0;
    for (const row of Array.isArray(rows) ? rows : []) written += fill.run(Buffer.from(row.bytes.buffer ?? row.bytes, row.bytes.byteOffset ?? 0, row.bytes.byteLength ?? row.bytes.length), row.scale, row.norm, row.rowid).changes;
    return { written };
  });
}

/**
 * The record-shaped line of a stored source and the lines before it its vector was made with (`vectors.context`
 * `sourceIds`, the message ids of the chunk's lines, its own last): `{ line, context }`, or null when the line is gone.
 */
export function chunkLinesOf(db, row) {
  let meta = {};
  try { meta = row.context ? JSON.parse(row.context) : {}; } catch { meta = {}; }
  const own = db.prepare('SELECT * FROM sources WHERE id = ?').get(row.source_id);
  if (!own || typeof own.text !== 'string' || !own.text.trim()) return null;
  const lineOf = (source) => {
    const author = source.author_account ? db.prepare('SELECT native_id FROM accounts WHERE id = ?').get(source.author_account)?.native_id ?? null : null;
    return { kind: source.kind, messageId: source.native_id, revision: source.revision ?? 1, occurredAt: source.occurred_at, by: author, text: source.text };
  };
  const ids = Array.isArray(meta.sourceIds) ? meta.sourceIds.filter((id) => typeof id === 'string' && id !== own.native_id) : [];
  const newest = db.prepare("SELECT * FROM sources WHERE native_id = ? AND authority_id IS ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1");
  const context = ids.map((id) => newest.get(id, own.authority_id)).filter((source) => source && typeof source.text === 'string' && source.text.trim()).map(lineOf);
  return { line: lineOf(own), context };
}

/**
 * The re-embed job (see the head of this file). Never throws for one row: a row whose input cannot be rebuilt, of
 * another model or dims, is counted and left evicted.
 * @returns {Promise<{ pending: number, embedded: number, written: number, skipped: number }>}
 */
export async function reembedTouched({ db, write, embed, config, now, quantize, model = null, chunkOf, limit = 50 }) {
  const rows = pendingReembed(db, { now, limit });
  const ready = [];
  let skipped = 0;
  for (const row of rows) {
    if (model && row.model && row.model !== model) { skipped += 1; continue; }
    const lines = chunkLinesOf(db, row);
    const text = lines ? chunkOf(lines.line, lines.context) : '';
    if (typeof text !== 'string' || !text.trim()) { skipped += 1; continue; }
    ready.push({ row, text });
  }
  if (ready.length === 0) return { pending: rows.length, embedded: 0, written: 0, skipped };
  const vectors = await embed(ready.map((entry) => entry.text), { config, purpose: 'memory-reembed' });
  const out = [];
  ready.forEach((entry, index) => {
    const vector = vectors?.[index];
    if (!vector || vector.length !== entry.row.dims) { skipped += 1; return; }
    const q = quantize(vector);
    out.push({ rowid: entry.row.rowid, bytes: new Uint8Array(q.bytes.buffer, q.bytes.byteOffset, q.bytes.byteLength), scale: q.scale, norm: q.norm });
  });
  const done = out.length > 0 ? await write({ kind: 'reembed', rows: out, now }) : { written: 0 };
  return { pending: rows.length, embedded: out.length, written: done?.written ?? 0, skipped };
}

/**
 * Checks her diary media files (see the head of this file).
 * @returns {{ present: number, missing: number, unknown: number, changed: number }}
 */
export function checkMedia(handle, { dataDir, apply = false }) {
  const db = handle.db ?? handle;
  const counts = { present: 0, missing: 0, unknown: 0, changed: 0 };
  const marks = [];
  for (const row of db.prepare('SELECT id, kind, path, bytes, availability FROM media WHERE retired_at IS NULL').iterate()) {
    if (row.kind !== 'diary' || typeof row.path !== 'string' || !row.path) { counts.unknown += 1; continue; }
    let state = 'missing';
    try {
      const stat = fs.statSync(path.join(dataDir, row.path));
      if (stat.isFile() && (!Number.isInteger(row.bytes) || stat.size === row.bytes)) state = 'present';
    } catch { /* no file */ }
    counts[state] += 1;
    if (state !== row.availability) marks.push([state, row.id]);
  }
  counts.changed = marks.length;
  if (apply && marks.length > 0) {
    const write = () => { const mark = db.prepare('UPDATE media SET availability = ? WHERE id = ?'); for (const [state, id] of marks) mark.run(state, id); };
    if (typeof handle.transaction === 'function') handle.transaction(write);
    else write();
  }
  return counts;
}

/**
 * One index-policy write on the writer connection (service.js): `{ kind: 'index-policy', now, config }` (classify, and
 * evict when `recall.db.vectorEviction` is on), `{ kind: 'touch', sourceIds, now, config }` or `{ kind: 'reembed', rows }`.
 */
export function applyIndexWrite(handle, update) {
  if (update?.kind === 'reembed') return applyReembed(handle, update);
  if (update?.kind === 'touch') return { touched: touch(handle, update.sourceIds, { now: update.now, config: update.config }) };
  const done = classify(handle, { now: update.now, config: update.config, apply: true, evict: indexSettings(update.config).eviction });
  return { tiers: done.tiers, evicted: done.evictedNow };
}
