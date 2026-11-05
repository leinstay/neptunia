// The vector index: one embedding per record message (with its chunk's context lines) or archive
// item, kept so recall can match meaning and not only words. Storage only: nothing here talks
// to a model; a caller hands in vectors and gets rows back.
//
// The index lives in the memory database (src/memory/db/service.ts), one unit per month of a row's
// `occurredAt`, `places/<g>/vectors/<YYYY-MM>` (a private chat's rows under
// `private/<userId>/vectors/` instead, never in the place index), holding what the three files of a
// month held: the manifest `{ v, gen, rows, bytes, metaBytes, model, dims, checksum }`, the int8 rows
// (`dims` bytes each) and one jsonl line per row (its provenance, scale and norm). Readers trust the
// manifest only. `rewrite` writes a new generation whole. Every row is quantised with its own scale
// (max abs / 127) and keeps the norm of the original vector, so a cosine is the int8 dot product
// times the scale over both norms. Writers (append, rewrite, replace) wait on the writer gate.
//
// `has` answers which messages and items a month already holds (the live queue's catch-up and
// the index tool's append of what is missing): the `chunkKey` of every row, read from the jsonl
// alone and kept per month while its manifest says the generation and the row count are the same
// (a grown month reads only its new lines, a new generation is read whole).
//
// `append` sends the month's new rows (the new manifest, the jsonl lines and their int8 bytes, the checksum
// continued from the stored manifest) and `rewrite` / `replace` the month's next generation whole, through
// `memoryDb.writeUnit` (op `vectors`): the `vectors` rows and the month's `operational` row as map/vectors.js maps
// them. A vector the index policy evicted (src/memory/db/index-policy.ts) is left out of a month as it is read.
//
// Logs carry counts, months and place ids, never a row's contents.

import path from 'node:path';
import type { Db } from './db/types.ts';
import { vectorAddresses, keyText } from './db/storage-keys.ts';

import { listUnits } from './db/storage-units.ts';

import { log as defaultLog } from '../log.ts';
import { isoOf } from './record.ts';
import { chunkKey } from './chunks.ts';

import { storedManifest, vectorMonthFiles, vectorMonthState } from './db/readers/vectors.ts';
import { propOf, isFiniteNumber, isIntegerNumber, readSeamOf } from './types.ts';
import type { MemoryDb, Untyped } from './types.ts';

const MONTH_RE = /^\d{4}-\d{2}$/;
const GEN_FILE_RE = /^(\d+)\.(i8|jsonl)$/;
const MANIFEST_VERSION = 1;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
/** Months whose row keys `has` keeps in memory, the least recently asked dropped first. */
const KEY_SETS_MAX = 64;

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

/** FNV-1a 32 over `bytes`, continued from `hash`. */
function fnv(hash: number, bytes: Uint8Array) {
  let h = hash >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** The manifest checksum: FNV-1a 32 of the int8 data and of the jsonl, `fnv1a32:<i8>:<jsonl>`. */
function checksumOf(i8Hash: number, metaHash: number) {
  return `fnv1a32:${hex(i8Hash)}:${hex(metaHash)}`;
}

/** The manifest checksum of a month's int8 data and jsonl bytes (what a fresh generation's manifest holds). */
export function monthChecksum(i8: Uint8Array, meta: Uint8Array): string {
  return checksumOf(fnv(FNV_OFFSET, i8), fnv(FNV_OFFSET, meta));
}

/** The two hash states of a checksum, or null. */
function parseChecksum(value: Untyped) {
  const match = String(value ?? '').match(/^fnv1a32:([0-9a-f]{8}):([0-9a-f]{8})$/);
  return match ? ([parseInt(match[1], 16), parseInt(match[2], 16)] as const) : null;
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

/** The parsed manifest, or null when it is missing or malformed. */
function validManifest(value: Untyped) {
  if (!value || typeof value !== 'object') return null;
  const ints = ['gen', 'rows', 'bytes', 'metaBytes', 'dims'];
  if (!ints.every((key) => isIntegerNumber(value[key]) && value[key] >= 0)) return null;
  if (value.gen < 1 || value.bytes !== value.rows * value.dims) return null;
  return value;
}

export type Vectors = {
  append(
    placeId: string,
    rows: Array<{ meta: object; vector: ArrayLike<number> }>,
    opts?: { model?: string | null }
  ): Promise<{ written: number }>;
  rewrite(
    placeId: string,
    month: string,
    keep: (meta: object) => boolean,
    _opts?: object
  ): Promise<{ kept: number; dropped: number }>;
  replace(
    placeId: string,
    month: string,
    rows: Array<{ meta: object; vector: ArrayLike<number> }>,
    opts?: { model?: string | null; keep?: ((meta: object) => boolean) | null }
  ): Promise<{ written: number; kept: number; dropped: number }>;
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

type VectorReplaceOptions = {
  model?: string | null;
  keep?: ((meta: object) => boolean) | null;
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

/** The parsed jsonl lines of `buf` (a line that does not parse becomes null). */
function parseLines(buf: Untyped) {
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(null);
    }
  }
  return out;
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

function shapeError(month: string) {
  return Object.assign(new Error(`vectors: month ${month} holds rows of another model or length`), {
    code: 'vectors-shape',
  });
}

/**
 * Create the vector index.
 *
 * @param options.dataDir  the `data/` directory (the units' names are relative to it)
 * @param [options.now=Date.now]  the month of a row without a readable `occurredAt`
 * @param [options.writerGate]  awaited before every append, `rewrite` and
 *   `replace` (the journal's `waitUnlocked`), so its writer lock holds them
 * @param [options.maxCacheBytes=268435456]  loaded months kept in memory (int8 data plus
 *   their jsonl bytes), least recently used evicted first
 * @param options.memoryDb  the memory database service (src/memory/db/service.ts): `search`, `stats`
 *   and `has` read the months from it (src/memory/db/readers/vectors.ts; an evicted vector is left out; a failed
 *   read rejects with a code), and the writers write it (see the head of this file), rejecting with the writer's
 *   code when it fails.
 *   A row's `meta`: `kind` ('record' | 'archive'), `id` (message id or item id), `revision`,
 *   `occurredAt`, `placeId`, `by`, `participants` (the union over the chunk's lines),
 *   `sourceIds` (the message ids of every chunk line); stored with `row`, `scale` and `norm`.
 *   `append` adds each row to the current generation of its month; every vector of one call has the same length, and a month
 *   already holding rows refuses another length or model (`code: 'vectors-shape'`). `rewrite`
 *   keeps the rows `keep` accepts in a new generation and does nothing when it keeps them all.
 *   `replace` builds a month anew (the index tool's build and rebuild): `rows` (every one of
 *   `month`) plus the current rows `keep` accepts, when they share the new rows' length and model,
 *   written whole as the next generation in one write, so a reader sees the old month or the new
 *   one, never half of it; nothing is written for no rows. `search` ranks rows by cosine
 *   (top `k`, best first) among the months asked (`null`: all) whose `occurredAt` lies in
 *   `[from, to]` and that `filter` accepts. A month whose rows do not match its manifest's checksum
 *   is skipped (logged).
 *   `has` resolves the `chunkKey` (`<kind>:<id>:<revision>`, src/memory/chunks.ts) of every row
 *   the month of the layer holds now (empty for a missing or unreadable month); the set is the
 *   cached one, read only, current as of the call: an append, a rewrite or a replace by this
 *   index or another process shows on the next call.
 */
export function createVectors({
  log = defaultLog,
  now = Date.now,
  writerGate = null,
  maxCacheBytes = DEFAULT_CACHE_BYTES,
  memoryDb = null,
}: VectorsDeps): Vectors {
  const seam = readSeamOf(memoryDb, log, 'vectors');
  // The last months rebuilt from the database, by their stored state (a grown month is a new state).
  const rebuilt = new Map(); // owner -> { stamp, files }
  const REBUILT_MAX = 4;
  const cache = new Map(); // `${base}|${month}` -> { gen, rows, dims, bytes, metaBytes, data, metas, hashes, size }
  const keySets = new Map(); // `${base}|${month}` -> { gen, rows, metaBytes, keys }
  let cachedBytes = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /** Run `task` after every write already queued. */
  function serial<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  const { baseDir, monthDir, vectorKey } = vectorAddresses();

  const genFile = (dir: string, gen: Untyped, ext: Untyped) => path.join(dir, `${gen}.${ext}`);

  function months(base: string, db: Db) {
    const key = vectorKey(base);
    return seam.run(() =>
      listUnits(db, { kind: 'vectors', subject: key.subject, scopePlaceId: key.scopePlaceId })
        .map((unit) => unit.key.partition!)
        .sort()
    );
  }

  /** A month's files rebuilt from the database (the last few kept while their stored state is unchanged), or null. */
  function rebuiltMonth(db: Untyped, dir: string) {
    const owner = vectorKey(dir);
    return seam.run(() => {
      const state = vectorMonthState(db, owner);
      if (!state) return null;
      const stamp = `${state.evicted}|${state.value}`;
      const held = rebuilt.get(keyText(owner));
      if (held && held.stamp === stamp) return held.files;
      const files = vectorMonthFiles(db, owner, { checksum: monthChecksum });
      rebuilt.delete(keyText(owner));
      rebuilt.set(keyText(owner), { stamp, files });
      while (rebuilt.size > REBUILT_MAX) rebuilt.delete(rebuilt.keys().next().value);
      return files;
    });
  }

  function readManifest(dir: string, db: Untyped) {
    const state = seam.run(() => vectorMonthState(db, vectorKey(dir)));
    if (!state) return null;
    return validManifest(state.evicted > 0 ? rebuiltMonth(db, dir)?.manifest : storedManifest(state.value));
  }

  /** `length` bytes of a month's `<gen>.i8` or `<gen>.jsonl` from `position`, as rebuilt from the database. */
  function readBytes(file: string, position: Untyped, length: Untyped, db: Untyped) {
    const files = rebuiltMonth(db, path.dirname(file));
    const match = path.basename(file).match(GEN_FILE_RE);
    if (!files || !match || Number(match[1]) !== files.manifest?.gen)
      throw Object.assign(new Error('vectors: no such generation'), { code: 'ENOENT' });
    const data = match[2] === 'i8' ? files.i8 : files.meta;
    if (position + length > data.length) {
      throw Object.assign(new Error('vectors: month shorter than its manifest'), { code: 'vectors-short' });
    }
    return Buffer.from(data.subarray(position, position + length));
  }

  function dropCached(key: string) {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.size;
    cache.delete(key);
  }

  function remember(key: string, entry: Untyped) {
    dropCached(key);
    cache.set(key, entry);
    cachedBytes += entry.size;
    for (const other of cache.keys()) {
      if (cachedBytes <= maxCacheBytes) break;
      if (other !== key) dropCached(other);
    }
  }

  /**
   * A month as the manifest names it: the cached copy, or the whole generation (always read whole: a vector embedded
   * again after an eviction comes back in the middle). Null when the month is empty, missing or fails its checksum.
   */
  function loadMonth(base: Untyped, month: string, retried: Untyped, db: Untyped) {
    const key = `${base}|${month}`;
    const dir = monthDir(base, month);
    const manifest = readManifest(dir, db);
    if (!manifest || manifest.rows === 0) {
      dropCached(key);
      return null;
    }
    const cached = cache.get(key);
    if (cached && cached.gen === manifest.gen && cached.rows === manifest.rows && cached.dims === manifest.dims) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    let dataBuf;
    let metaBuf;
    try {
      dataBuf = readBytes(genFile(dir, manifest.gen, 'i8'), 0, manifest.bytes, db);
      metaBuf = readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes, db);
    } catch (error) {
      // A rewrite switched the generation between the manifest and the rows: read it again.
      if (propOf(error, 'code') === 'ENOENT' && !retried) return loadMonth(base, month, true, db);
      if (propOf(error, 'code') === 'ENOENT' || propOf(error, 'code') === 'vectors-short') {
        log.warn('vectors: month unreadable', { month, code: propOf(error, 'code') });
        dropCached(key);
        return null;
      }
      throw error;
    }
    const hashes: [number, number] = [fnv(FNV_OFFSET, dataBuf), fnv(FNV_OFFSET, metaBuf)];
    if (checksumOf(...hashes) !== manifest.checksum) {
      log.warn('vectors: checksum mismatch', { month, gen: manifest.gen });
      dropCached(key);
      return null;
    }
    const metas = parseLines(metaBuf);
    if (metas.length !== manifest.rows) {
      log.warn('vectors: month unreadable', { month, code: 'row-count' });
      dropCached(key);
      return null;
    }
    const data = new Int8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length);
    const entry = {
      gen: manifest.gen,
      rows: manifest.rows,
      dims: manifest.dims,
      bytes: manifest.bytes,
      metaBytes: manifest.metaBytes,
      data,
      metas,
      hashes,
      size: manifest.bytes + manifest.metaBytes,
    };
    remember(key, entry);
    return entry;
  }

  /** The month of an ISO time (`now` when unreadable) and the ISO time itself. */
  function placed(occurredAt: Untyped) {
    const iso = isoOf(occurredAt) ?? new Date(now()).toISOString();
    return { iso, month: iso.slice(0, 7) };
  }

  /** The database's writer of a month: one write, resolved once committed. */
  async function writeMonth(dir: string, payload: Untyped) {
    if (typeof memoryDb?.writeUnit !== 'function')
      throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    await memoryDb.writeUnit({ op: 'vectors', key: vectorKey(dir), ...payload });
  }

  async function appendMonth(
    base: string,
    month: string,
    items: Array<PlacedRow>,
    dims: number,
    model: string | null,
    db: Untyped
  ) {
    const dir = monthDir(base, month);
    const current = readManifest(dir, db);
    let manifest = current ?? {
      v: MANIFEST_VERSION,
      gen: 1,
      rows: 0,
      bytes: 0,
      metaBytes: 0,
      model: model ?? null,
      dims,
      checksum: checksumOf(FNV_OFFSET, FNV_OFFSET),
    };
    if (manifest.rows > 0 && (manifest.dims !== dims || (model && manifest.model && model !== manifest.model)))
      throw shapeError(month);
    if (manifest.rows === 0) manifest = { ...manifest, dims, model: model ?? manifest.model ?? null };
    const hashes = parseChecksum(manifest.checksum) ?? [FNV_OFFSET, FNV_OFFSET];
    const data = Buffer.alloc(items.length * dims);
    let lines = '';
    items.forEach(({ quantized, meta, iso }, i: number) => {
      data.set(quantized.bytes, i * dims);
      lines += `${JSON.stringify(storedMeta(meta, manifest.rows + i, iso, quantized.scale, quantized.norm))}\n`;
    });
    const metaBuf = Buffer.from(lines, 'utf8');
    const next = {
      ...manifest,
      v: MANIFEST_VERSION,
      rows: manifest.rows + items.length,
      bytes: manifest.bytes + data.length,
      metaBytes: manifest.metaBytes + metaBuf.length,
      checksum: checksumOf(fnv(hashes[0], data), fnv(hashes[1], metaBuf)),
    };
    await writeMonth(dir, { delta: { manifest: next, meta: lines, i8: data } });
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
      const dims = list[0].vector.length;
      if (!isIntegerNumber(dims) || dims < 1) throw new TypeError('vectors: an empty vector');
      const byMonth = new Map();
      for (const row of list) {
        if (row.vector.length !== dims) throw new TypeError('vectors: vectors of one append differ in length');
        const { iso, month } = placed(row.meta?.occurredAt);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push({ quantized: quantize(row.vector), meta: row.meta, iso });
      }
      const base = baseDir(placeId);
      const db = seam.db();
      for (const [month, items] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
        await appendMonth(base, month, items, dims, model, db);
      }
      log.info('vectors: appended', { placeId: String(placeId), rows: list.length, months: byMonth.size });
      return { written: list.length };
    });
  }

  /** Rewrite one month into a new generation with the rows `keep` accepts. */
  async function rewriteMonth(base: Untyped, month: string, keep: Untyped, db: Untyped) {
    const dir = monthDir(base, month);
    const manifest = readManifest(dir, db);
    if (!manifest || manifest.rows === 0) return { kept: 0, dropped: 0 };
    const data = readBytes(genFile(dir, manifest.gen, 'i8'), 0, manifest.bytes, db);
    const metas = parseLines(readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes, db));
    const keptRows = [];
    for (let row = 0; row < manifest.rows; row += 1) {
      const meta = metas[row];
      if (meta && keep(meta)) keptRows.push(row);
    }
    const dropped = manifest.rows - keptRows.length;
    if (dropped === 0) return { kept: keptRows.length, dropped: 0 };
    const gen = manifest.gen + 1;
    const out = Buffer.alloc(keptRows.length * manifest.dims);
    let lines = '';
    keptRows.forEach((row, i) => {
      data.copy(out, i * manifest.dims, row * manifest.dims, (row + 1) * manifest.dims);
      lines += `${JSON.stringify({ ...metas[row], row: i })}\n`;
    });
    const metaBuf = Buffer.from(lines, 'utf8');
    const nextManifest = {
      ...manifest,
      v: MANIFEST_VERSION,
      gen,
      rows: keptRows.length,
      bytes: out.length,
      metaBytes: metaBuf.length,
      checksum: checksumOf(fnv(FNV_OFFSET, out), fnv(FNV_OFFSET, metaBuf)),
    };
    await writeMonth(dir, { value: { manifest: nextManifest, meta: lines, i8: out } });
    return { kept: keptRows.length, dropped };
  }

  async function rewrite(placeId: string, month: string, keep: (meta: object) => boolean) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const result = await rewriteMonth(baseDir(placeId), String(month), keep, seam.db());
      if (result.dropped > 0) log.info('vectors: rewritten', { placeId: String(placeId), month, ...result });
      return result;
    });
  }

  /**
   * One month built anew: `items` (quantised, all of `month`) plus the current generation's rows
   * `keep` accepts (none when they are of another length or model), written as the next generation.
   */
  async function replaceMonth(
    base: string,
    month: string,
    items: Array<PlacedRow>,
    dims: number,
    model: string | null,
    keep: ((meta: object) => boolean) | null,
    db: Untyped
  ) {
    const dir = monthDir(base, month);
    const manifest = readManifest(dir, db);
    const kept = [];
    if (
      manifest &&
      manifest.rows > 0 &&
      typeof keep === 'function' &&
      manifest.dims === dims &&
      !(model && manifest.model && model !== manifest.model)
    ) {
      const data = readBytes(genFile(dir, manifest.gen, 'i8'), 0, manifest.bytes, db);
      const metas = parseLines(readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes, db));
      for (let row = 0; row < manifest.rows; row += 1) {
        if (metas[row] && keep(metas[row]))
          kept.push({ meta: metas[row], bytes: data.subarray(row * dims, (row + 1) * dims) });
      }
    }
    const gen = (manifest?.gen ?? 0) + 1;
    const rows = items.length + kept.length;
    const out = Buffer.alloc(rows * dims);
    let lines = '';
    items.forEach(({ quantized, meta, iso }, i: number) => {
      out.set(quantized.bytes, i * dims);
      lines += `${JSON.stringify(storedMeta(meta, i, iso, quantized.scale, quantized.norm))}\n`;
    });
    kept.forEach(({ meta, bytes }, j) => {
      const row = items.length + j;
      out.set(bytes, row * dims);
      lines += `${JSON.stringify({ ...meta, row })}\n`;
    });
    const metaBuf = Buffer.from(lines, 'utf8');
    const nextManifest = {
      v: MANIFEST_VERSION,
      gen,
      rows,
      bytes: out.length,
      metaBytes: metaBuf.length,
      model: model ?? manifest?.model ?? null,
      dims,
      checksum: checksumOf(fnv(FNV_OFFSET, out), fnv(FNV_OFFSET, metaBuf)),
    };
    await writeMonth(dir, { value: { manifest: nextManifest, meta: lines, i8: out } });
    return { written: items.length, kept: kept.length, dropped: (manifest?.rows ?? 0) - kept.length };
  }

  async function replace(
    placeId: string,
    month: string,
    rows: Array<{ meta: Untyped; vector: ArrayLike<number> }>,
    { model = null, keep = null }: VectorReplaceOptions = {}
  ) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && row.vector);
      if (list.length === 0) return { written: 0, kept: 0, dropped: 0 };
      const dims = list[0].vector.length;
      if (!isIntegerNumber(dims) || dims < 1) throw new TypeError('vectors: an empty vector');
      const items = list.map((row) => {
        if (row.vector.length !== dims) throw new TypeError('vectors: vectors of one replace differ in length');
        const { iso, month: rowMonth } = placed(row.meta?.occurredAt);
        if (rowMonth !== String(month)) throw new TypeError(`vectors: a row of ${rowMonth} in a replace of ${month}`);
        return { quantized: quantize(row.vector), meta: row.meta, iso };
      });
      const result = await replaceMonth(baseDir(placeId), String(month), items, dims, model, keep, seam.db());
      log.info('vectors: replaced', { placeId: String(placeId), month: String(month), ...result });
      return result;
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
    const db = seam.db();
    const fromIso = from === null || from === undefined ? null : isoOf(from);
    const toIso = to === null || to === undefined ? null : isoOf(to);
    const fromMs = fromIso ? Date.parse(fromIso) : -Infinity;
    const toMs = toIso ? Date.parse(toIso) : Infinity;
    const wanted = Array.isArray(asked) ? new Set(asked) : null;
    const base = baseDir(placeId);
    const heap: Array<{ meta: Untyped; score: number }> = [];
    for (const month of months(base, db)) {
      if (wanted && !wanted.has(month)) continue;
      if ((fromIso && month < fromIso.slice(0, 7)) || (toIso && month > toIso.slice(0, 7))) continue;
      const entry = loadMonth(base, month, false, db);
      if (!entry) continue;
      if (entry.dims !== q.length) {
        log.warn('vectors: dims mismatch', { month, dims: entry.dims, query: q.length });
        continue;
      }
      const { data, metas, dims } = entry;
      for (let row = 0; row < entry.rows; row += 1) {
        const meta = metas[row];
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
      if (entry.size > maxCacheBytes) dropCached(`${base}|${month}`);
    }
    return heap.sort((a, b) => b.score - a.score);
  }

  async function stats(placeId: string) {
    const db = seam.db();
    const base = baseDir(placeId);
    let count = 0;
    let rows = 0;
    let bytes = 0;
    for (const month of months(base, db)) {
      const manifest = readManifest(monthDir(base, month), db);
      if (!manifest) continue;
      count += 1;
      rows += manifest.rows;
      bytes += manifest.bytes + manifest.metaBytes;
    }
    return { months: count, rows, bytes };
  }

  /** The row keys of one month: the cached set, or read whole. */
  function keysOf(base: Untyped, month: string, retried: Untyped, db: Untyped) {
    const key = `${base}|${month}`;
    const dir = monthDir(base, month);
    const manifest = readManifest(dir, db);
    if (!manifest || manifest.rows === 0) {
      keySets.delete(key);
      return new Set();
    }
    const held = keySets.get(key);
    if (held && held.gen === manifest.gen && held.rows === manifest.rows) {
      keySets.delete(key);
      keySets.set(key, held);
      return held.keys;
    }
    let buf;
    try {
      buf = readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes, db);
    } catch (error) {
      // A rewrite switched the generation between the manifest and the rows: read it again.
      if (propOf(error, 'code') === 'ENOENT' && !retried) return keysOf(base, month, true, db);
      if (propOf(error, 'code') === 'ENOENT' || propOf(error, 'code') === 'vectors-short') {
        log.warn('vectors: month unreadable', { month, code: propOf(error, 'code') });
        keySets.delete(key);
        return new Set();
      }
      throw error;
    }
    const keys = new Set();
    for (const meta of parseLines(buf)) if (meta) keys.add(chunkKey(meta));
    keySets.delete(key);
    keySets.set(key, { gen: manifest.gen, rows: manifest.rows, metaBytes: manifest.metaBytes, keys });
    while (keySets.size > KEY_SETS_MAX) keySets.delete(keySets.keys().next().value);
    return keys;
  }

  async function has(placeId: string, month: string) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    return keysOf(baseDir(placeId), String(month), false, seam.db());
  }

  return { append, rewrite, replace, search, stats, has };
}
