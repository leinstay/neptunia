// The vector index: one embedding per record message (with its chunk's context lines) or archive
// item, kept so recall can match meaning and not only words. Storage only: nothing here talks
// to a model; a caller hands in vectors and gets rows back.
//
// The index lives in the memory database (src/memory/db/service.ts) as `vectors` rows of a place (a root, or a private
// chat's DM place, never mixed), one per line, in the month of its `occurredAt` (src/memory/db/line-vectors.ts). A row
// holds the int8 vector (`dims` bytes) and its line: provenance, `row` (its position in the month), scale and norm.
// Every row is quantised with its own scale (max abs / 127) and keeps the norm of the original vector, so a cosine is the
// int8 dot product times the scale over both norms. `append` writes through the write kind `line-vectors` and waits on
// the writer gate. A vector the index policy evicted (src/memory/db/index-policy.ts) is left out of a month as it is read.
//
// `search` scans the months it is asked for, each read once into memory and kept while the month's stamp is unchanged
// (line-vectors.ts#lineVectorStamps), least recently used dropped past `maxCacheBytes`. `has` answers which messages and
// items a month already holds (the live queue's catch-up and the index tool's append of what is missing).
//
// Logs carry counts, months and place ids, never a row's contents.

import { log as defaultLog } from '../log.ts';
import { isoOf } from './record.ts';
import {
  lineVectorKeys,
  lineVectorMonth,
  lineVectorMonths,
  lineVectorShape,
  lineVectorStamps,
} from './db/line-vectors.ts';
import type { LineVectorMonth } from './db/line-vectors.ts';
import { isFiniteNumber, isIntegerNumber, readSeamOf } from './types.ts';
import type { MemoryDb, Untyped } from './types.ts';

const MONTH_RE = /^\d{4}-\d{2}$/;
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * One vector as int8 with its own scale: `scale` = max |v| / 127 (0 for an all-zero vector),
 * `bytes[i]` = round(v[i] / scale); `norm` is the Euclidean norm of the original vector.
 */
export function quantize(vector: ArrayLike<number>): { bytes: Int8Array; scale: number; norm: number } {
  const length = vector?.length ?? 0;
  const bytes = new Int8Array(length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const x = vector[i];
    if (!isFiniteNumber(x)) throw new TypeError('vectors: a component is not a finite number');
    const abs = Math.abs(x);
    if (abs > max) max = abs;
    sum += x * x;
  }
  const scale = max / 127;
  if (scale > 0) {
    for (let i = 0; i < length; i += 1) {
      const q = Math.round(vector[i] / scale);
      bytes[i] = q > 127 ? 127 : q < -127 ? -127 : q;
    }
  }
  return { bytes, scale, norm: Math.sqrt(sum) };
}

/** A row placed in its month: the int8 vector, the row's meta and its time as an ISO string. */
type PlacedRow = { quantized: ReturnType<typeof quantize>; meta: Untyped; iso: string };

/**
 * The approximate float vector of an int8 row.
 */
export function dequantize(bytes: Int8Array, scale: number): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] * scale;
  return out;
}

/** Distinct non-empty strings of `values` (arrays), in order. */
function idList(...values: Array<unknown>): Array<string> {
  const out: Array<string> = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

export type Vectors = {
  append(
    placeId: string,
    rows: Array<{ meta: object; vector: ArrayLike<number> }>,
    opts?: { model?: string | null }
  ): Promise<{ written: number }>;
  search(
    placeId: string,
    query: ArrayLike<number>,
    opts?: {
      months?: Array<string> | null;
      from?: string | number | null;
      to?: string | number | null;
      filter?: ((meta: object) => boolean) | null;
      k?: number;
    }
  ): Promise<Array<{ meta: object; score: number }>>;
  stats(placeId: string, _opts?: object): Promise<{ months: number; rows: number; bytes: number }>;
  has(placeId: string, month: string, _opts?: object): Promise<Set<string>>;
};

type VectorSearchOptions = {
  months?: Array<string> | null;
  from?: string | number | null;
  to?: string | number | null;
  filter?: ((meta: object) => boolean) | null;
  k?: number;
};

type VectorsDeps = {
  dataDir: string;
  log?: { info: Untyped; warn: Untyped };
  now?: () => number;
  writerGate?: (() => Promise<void>) | null;
  maxCacheBytes?: number;
  memoryDb: MemoryDb | null;
};

/** Push `item` into the min-heap `heap` of at most `k` items by score. */
function offer<TItem extends { score: number }>(heap: Array<TItem>, k: number, item: TItem) {
  if (heap.length < k) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].score <= heap[i].score) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
    return;
  }
  if (item.score <= heap[0].score) return;
  heap[0] = item;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let least = i;
    if (left < heap.length && heap[left].score < heap[least].score) least = left;
    if (right < heap.length && heap[right].score < heap[least].score) least = right;
    if (least === i) break;
    [heap[least], heap[i]] = [heap[i], heap[least]];
    i = least;
  }
}

/** The stored line of a row: the whitelisted meta fields, its index, scale and norm. */
function storedMeta(meta: Untyped, row: Untyped, iso: string, scale: Untyped, norm: Untyped) {
  const source = meta && typeof meta === 'object' ? meta : {};
  return {
    row,
    kind: source.kind === 'archive' ? 'archive' : 'record',
    id: typeof source.id === 'string' ? source.id : String(source.id ?? ''),
    revision: source.revision ?? null,
    occurredAt: iso,
    placeId: typeof source.placeId === 'string' && source.placeId ? source.placeId : null,
    by: typeof source.by === 'string' && source.by ? source.by : null,
    participants: idList(source.participants),
    sourceIds: idList(source.sourceIds),
    scale,
    norm,
  };
}

/** The dimension count of a row's vector: every row of one write must share it. */
const dimsOf = (row: Untyped): unknown => row.vector.length;

function shapeError(month: string) {
  return Object.assign(new Error(`vectors: month ${month} holds rows of another model or length`), {
    code: 'vectors-shape',
  });
}

/**
 * Create the vector index.
 *
 * @param [options.now=Date.now]  the month of a row without a readable `occurredAt`
 * @param [options.writerGate]  awaited before every append (the journal's `waitUnlocked`), so its writer lock holds it
 * @param [options.maxCacheBytes=268435456]  months kept in memory (their int8 data), least recently used dropped first
 * @param options.memoryDb  the memory database service (src/memory/db/service.ts): `search`, `stats` and `has` read the
 *   rows from it (src/memory/db/line-vectors.ts; a failed read rejects with a code), and `append` writes through it,
 *   rejecting with the writer's code when it fails.
 *   A row's `meta`: `kind` ('record' | 'archive'), `id` (message id or item id), `revision`,
 *   `occurredAt`, `placeId`, `by`, `participants` (the union over the chunk's lines),
 *   `sourceIds` (the message ids of every chunk line); stored with `row`, `scale` and `norm`.
 *   `append` adds each row after the rows of its month; every vector of one call has the same length, and a month
 *   already holding rows refuses another length or model (`code: 'vectors-shape'`). `search` ranks rows by cosine
 *   (top `k`, best first) among the months asked (`null`: all) whose `occurredAt` lies in `[from, to]` and that
 *   `filter` accepts. `has` resolves the `chunkKey` (`<kind>:<id>:<revision>`, src/memory/chunks.ts) of every row the
 *   month of the place holds now (empty for a month with none).
 */
export function createVectors({
  log = defaultLog,
  now = Date.now,
  writerGate = null,
  maxCacheBytes = DEFAULT_CACHE_BYTES,
  memoryDb = null,
}: VectorsDeps): Vectors {
  const seam = readSeamOf(memoryDb, log, 'vectors');
  const cache = new Map<string, { stamp: string; month: LineVectorMonth; size: number }>(); // `${place}|${month}`
  let cachedBytes = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /** Run `task` after every write already queued. */
  function serial<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function dropCached(key: string) {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.size;
    cache.delete(key);
  }

  /** A month of a place: the cached copy while its stamp is the stored one, else read from the rows. */
  function loadMonth(placeId: string, month: string, stamp: string): LineVectorMonth | null {
    const key = `${placeId}|${month}`;
    const held = cache.get(key);
    if (held && held.stamp === stamp) {
      cache.delete(key);
      cache.set(key, held);
      return held.month;
    }
    dropCached(key);
    const read = seam.run(() => lineVectorMonth(seam.db(), placeId, month));
    if (!read) return null;
    const size = read.data.length;
    cache.set(key, { stamp, month: read, size });
    cachedBytes += size;
    for (const other of cache.keys()) {
      if (cachedBytes <= maxCacheBytes) break;
      if (other !== key) dropCached(other);
    }
    return read;
  }

  /** The month of an ISO time (`now` when unreadable) and the ISO time itself. */
  function placed(occurredAt: Untyped) {
    const iso = isoOf(occurredAt) ?? new Date(now()).toISOString();
    return { iso, month: iso.slice(0, 7) };
  }

  async function appendMonth(
    placeId: string,
    month: string,
    items: Array<PlacedRow>,
    dims: number,
    model: string | null
  ) {
    if (typeof memoryDb?.writeLineVectors !== 'function')
      throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    const shape = seam.run(() => lineVectorShape(seam.db(), placeId, month));
    if (shape && (shape.dims !== dims || (model && shape.model && model !== shape.model))) throw shapeError(month);
    const before = shape?.rows ?? 0;
    const lines = items.map(({ quantized, meta, iso }, i) => ({
      line: storedMeta(meta, before + i, iso, quantized.scale, quantized.norm),
      bytes: new Uint8Array(quantized.bytes.buffer, quantized.bytes.byteOffset, quantized.bytes.length),
    }));
    // A month keeps the model it was first written with.
    await memoryDb.writeLineVectors({ op: 'append', placeId, month, model: shape ? shape.model : model, lines });
  }

  async function append(
    placeId: string,
    rows: Array<{ meta: Untyped; vector: ArrayLike<number> }>,
    { model = null }: { model?: string | null } = {}
  ) {
    // Outside the chain: a writer queued behind a held append would wait for itself.
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && row.vector);
      if (list.length === 0) return { written: 0 };
      const dims = dimsOf(list[0]);
      if (!isIntegerNumber(dims) || dims < 1) throw new TypeError('vectors: an empty vector');
      const byMonth = new Map<string, Array<PlacedRow>>();
      for (const row of list) {
        if (row.vector.length !== dims) throw new TypeError('vectors: vectors of one append differ in length');
        const { iso, month } = placed(row.meta?.occurredAt);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month)!.push({ quantized: quantize(row.vector), meta: row.meta, iso });
      }
      for (const [month, items] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
        await appendMonth(String(placeId), month, items, dims, model);
      }
      log.info('vectors: appended', { placeId: String(placeId), rows: list.length, months: byMonth.size });
      return { written: list.length };
    });
  }

  async function search(
    placeId: string,
    query: ArrayLike<number>,
    { months: asked = null, from = null, to = null, filter = null, k = 10 }: VectorSearchOptions = {}
  ) {
    const limit = isIntegerNumber(k) && k > 0 ? k : 0;
    if (!limit || !query?.length) return [];
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    let qq = 0;
    for (let i = 0; i < q.length; i += 1) qq += q[i] * q[i];
    const qNorm = Math.sqrt(qq);
    if (!(qNorm > 0)) return [];
    const fromIso = from === null || from === undefined ? null : isoOf(from);
    const toIso = to === null || to === undefined ? null : isoOf(to);
    const fromMs = fromIso ? Date.parse(fromIso) : -Infinity;
    const toMs = toIso ? Date.parse(toIso) : Infinity;
    const wanted = Array.isArray(asked) ? new Set(asked) : null;
    const place = String(placeId);
    const heap: Array<{ meta: Untyped; score: number }> = [];
    const stamps = seam.run(() => lineVectorStamps(seam.db(), place));
    for (const [month, stamp] of stamps) {
      if (wanted && !wanted.has(month)) continue;
      if ((fromIso && month < fromIso.slice(0, 7)) || (toIso && month > toIso.slice(0, 7))) continue;
      const entry = loadMonth(place, month, stamp);
      if (!entry) continue;
      if (entry.dims !== q.length) {
        log.warn('vectors: dims mismatch', { month, dims: entry.dims, query: q.length });
        continue;
      }
      const { data, metas, dims } = entry;
      for (let row = 0; row < entry.rows; row += 1) {
        const meta: Untyped = metas[row];
        if (!meta || !(meta.norm > 0) || !(meta.scale > 0)) continue;
        const at = Date.parse(meta.occurredAt);
        if (isFiniteNumber(at) && (at < fromMs || at > toMs)) continue;
        if (typeof filter === 'function' && !filter(meta)) continue;
        let dot = 0;
        const offset = row * dims;
        for (let j = 0; j < dims; j += 1) dot += data[offset + j] * q[j];
        offer(heap, limit, { meta, score: (dot * meta.scale) / (qNorm * meta.norm) });
      }
      // A month larger than the whole bound is not kept after its scan.
      if (data.length > maxCacheBytes) dropCached(`${place}|${month}`);
    }
    return heap.sort((a, b) => b.score - a.score);
  }

  async function stats(placeId: string) {
    const db = seam.db();
    let count = 0;
    let rows = 0;
    let bytes = 0;
    for (const month of seam.run(() => lineVectorMonths(db, String(placeId)))) {
      const read = seam.run(() => lineVectorMonth(db, String(placeId), month));
      if (!read) continue;
      count += 1;
      rows += read.rows;
      // The int8 bytes and the text of the lines, what the month's files held.
      bytes +=
        read.data.length + read.metas.reduce((sum, meta) => sum + Buffer.byteLength(`${JSON.stringify(meta)}\n`), 0);
    }
    return { months: count, rows, bytes };
  }

  async function has(placeId: string, month: string) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    return seam.run(() => lineVectorKeys(seam.db(), String(placeId), String(month)));
  }

  return { append, search, stats, has };
}
