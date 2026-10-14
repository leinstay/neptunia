// The vector index: one embedding per record message (with its chunk's context lines) or archive
// item, kept so recall can match meaning and not only words. Storage only: nothing here talks
// to a model; a caller hands in vectors and gets rows back.
//
// Layout, per month of a row's `occurredAt`:
//
//   data/guilds/<g>/vectors/<YYYY-MM>/manifest.json   { v, gen, rows, bytes, metaBytes, model, dims, checksum }
//   data/guilds/<g>/vectors/<YYYY-MM>/<gen>.i8        int8 rows, `dims` bytes each
//   data/guilds/<g>/vectors/<YYYY-MM>/<gen>.jsonl     one line per row (its provenance, scale and norm)
//
// a private chat's rows under `private/<userId>/vectors/` instead, never in the guild index.
// Readers trust the manifest only: bytes past its counts (a crash between the data and the
// manifest) are ignored and cut on the next append. `rewrite` (a forget, a rebuild) writes a new
// generation whole, switches the manifest by rename, then deletes the older generations. Every
// row is quantised with its own scale (max abs / 127) and keeps the norm of the original vector,
// so a cosine is the int8 dot product times the scale over both norms.
//
// Forgetting follows the record and the archive: `forgetUser` drops every row naming the member
// (`recordDrops` / `archiveDrops` over the row's author and the union of its chunk's
// participants), and `search` hides a member under a forgetting marker or in the deletion ledger
// even before the rewrite has run. Writers (append, rewrite) wait on the writer gate.
//
// Logs carry counts, months and guild ids, never a row's contents.

import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { log as defaultLog } from '../log.js';
import { forgettingIds, isoOf, recordDrops } from './record.js';
import { archiveDrops } from './archive.js';
import { readLedger } from './store.js';

const MONTH_RE = /^\d{4}-\d{2}$/;
const GEN_FILE_RE = /^(\d+)\.(i8|jsonl)$/;
const MANIFEST_VERSION = 1;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * One vector as int8 with its own scale: `scale` = max |v| / 127 (0 for an all-zero vector),
 * `bytes[i]` = round(v[i] / scale); `norm` is the Euclidean norm of the original vector.
 * @param {ArrayLike<number>} vector
 * @returns {{ bytes: Int8Array, scale: number, norm: number }}
 */
export function quantize(vector) {
  const length = vector?.length ?? 0;
  const bytes = new Int8Array(length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const x = vector[i];
    if (!Number.isFinite(x)) throw new TypeError('vectors: a component is not a finite number');
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

/**
 * The approximate float vector of an int8 row.
 * @param {Int8Array} bytes
 * @param {number} scale
 * @returns {Float32Array}
 */
export function dequantize(bytes, scale) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] * scale;
  return out;
}

/** FNV-1a 32 over `bytes`, continued from `hash`. */
function fnv(hash, bytes) {
  let h = hash >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');

/** The manifest checksum: FNV-1a 32 of the int8 data and of the jsonl, `fnv1a32:<i8>:<jsonl>`. */
function checksumOf(i8Hash, metaHash) {
  return `fnv1a32:${hex(i8Hash)}:${hex(metaHash)}`;
}

/** The two hash states of a checksum, or null. */
function parseChecksum(value) {
  const match = String(value ?? '').match(/^fnv1a32:([0-9a-f]{8}):([0-9a-f]{8})$/);
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16)] : null;
}

/** Distinct non-empty strings of `values` (arrays), in order. */
function idList(...values) {
  const out = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/**
 * Whether forgetting `userId` drops this row: an archive row by `archiveDrops`, a record row by
 * `recordDrops`, each over the row's author and the union of its chunk's participants; with
 * `messageIds`, also a row whose chunk holds one of those messages.
 */
function rowDrops(meta, userId, before = null, messageIds = null) {
  const participants = idList(meta?.participants, meta?.by);
  if (messageIds && messageIds.size > 0 && Array.isArray(meta?.sourceIds) && meta.sourceIds.some((id) => messageIds.has(id))) {
    if (!Number.isFinite(before) || !(Date.parse(meta.occurredAt) >= before)) return true;
  }
  if (meta?.kind === 'archive') return archiveDrops({ participants, recordedAt: meta.occurredAt }, userId, before);
  return recordDrops({ by: meta?.by ?? null, participants, occurredAt: meta?.occurredAt }, userId, before);
}

/** Whether a row happened before `before` (an unreadable time counts as earlier). */
const earlier = (meta, before) => !(Date.parse(meta?.occurredAt) >= before);

/** The parsed manifest, or null when it is missing or malformed. */
function validManifest(value) {
  if (!value || typeof value !== 'object') return null;
  const ints = ['gen', 'rows', 'bytes', 'metaBytes', 'dims'];
  if (!ints.every((key) => Number.isInteger(value[key]) && value[key] >= 0)) return null;
  if (value.gen < 1 || value.bytes !== value.rows * value.dims) return null;
  return value;
}

/**
 * Create the vector index.
 *
 * @param {object} options
 * @param {string} options.dataDir  the `data/` directory
 * @param {object} [options.fs]  a `node:fs/promises`-shaped API
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {() => number} [options.now=Date.now]  the month of a row without a readable `occurredAt`
 * @param {(() => Promise<void>)|null} [options.writerGate]  awaited before every append and
 *   `rewrite` (the journal's `waitUnlocked`), so a forget's writer lock holds them; `forgetUser`
 *   runs under that lock and does not wait on it
 * @param {number} [options.maxCacheBytes=268435456]  loaded months kept in memory (int8 data plus
 *   their jsonl bytes), least recently used evicted first
 * @returns {{
 *   append(guildId: string, rows: Array<{ meta: object, vector: ArrayLike<number> }>,
 *     opts?: { privateUserId?: string|null, model?: string|null }): Promise<{ written: number }>,
 *   rewrite(guildId: string, month: string, keep: (meta: object) => boolean,
 *     opts?: { privateUserId?: string|null }): Promise<{ kept: number, dropped: number }>,
 *   replace(guildId: string, month: string, rows: Array<{ meta: object, vector: ArrayLike<number> }>,
 *     opts?: { privateUserId?: string|null, model?: string|null, keep?: ((meta: object) => boolean)|null }):
 *     Promise<{ written: number, kept: number, dropped: number }>,
 *   forgetUser(guildId: string, userId: string, opts?: { before?: number|null,
 *     messageIds?: Iterable<string>|null }): Promise<{ dropped: number, privateDropped: number }>,
 *   search(guildId: string, query: ArrayLike<number>, opts?: { months?: string[]|null,
 *     from?: string|number|null, to?: string|number|null, filter?: ((meta: object) => boolean)|null,
 *     k?: number, privateUserId?: string|null }): Promise<Array<{ meta: object, score: number }>>,
 *   stats(guildId: string, opts?: { privateUserId?: string|null }): Promise<{ months: number, rows: number, bytes: number }>,
 * }}
 *   A row's `meta`: `kind` ('record' | 'archive'), `id` (message id or item id), `revision`,
 *   `occurredAt`, `channelId`, `by`, `participants` (the union over the chunk's lines),
 *   `sourceIds` (the message ids of every chunk line); stored with `row`, `scale` and `norm`.
 *   `append` writes each row to the current generation of its month (the int8 data, then the jsonl
 *   line, then the manifest by rename); every vector of one call has the same length, and a month
 *   already holding rows refuses another length or model (`code: 'vectors-shape'`). `rewrite`
 *   keeps the rows `keep` accepts in a new generation and does nothing when it keeps them all.
 *   `replace` builds a month anew (the index tool's build and rebuild): `rows` (every one of
 *   `month`) plus the current rows `keep` accepts, when they share the new rows' length and model,
 *   written whole as the next generation and switched in by the manifest's rename, so a reader
 *   sees the old month or the new one, never half of it; nothing is written for no rows.
 *   `forgetUser` writes the forgetting marker unless one exists (and removes the one it wrote),
 *   rewrites every month of the guild and of every other private layer without the rows naming the
 *   member (by author, participants, or, with `messageIds`, a chunk line among those messages) and
 *   deletes the member's own private index; with `before` (the deletion ledger re-applied) it
 *   writes no marker and drops only rows that happened earlier, the member's private rows included.
 *   `dropped` counts guild rows, `privateDropped` private ones. `search` ranks rows by cosine
 *   (top `k`, best first) among the months asked (`null`: all) whose `occurredAt` lies in
 *   `[from, to]` and that `filter` accepts, leaving out the rows of a member under a forgetting
 *   marker or forgotten in the ledger (rows before their ledger time), and a private layer whose
 *   member is either. A month whose files do not match its manifest's checksum is skipped (logged).
 */
export function createVectors({ dataDir, fs = nodeFs, log = defaultLog, now = Date.now, writerGate = null, maxCacheBytes = DEFAULT_CACHE_BYTES }) {
  const cache = new Map(); // `${base}|${month}` -> { gen, rows, dims, bytes, metaBytes, data, metas, hashes, size }
  let cachedBytes = 0;
  let chain = Promise.resolve();

  /** Run `task` after every write already queued. */
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  const guildDir = (guildId) => path.join(dataDir, 'guilds', String(guildId));

  function baseDir(guildId, privateUserId = null) {
    return typeof privateUserId === 'string' && privateUserId
      ? path.join(guildDir(guildId), 'private', privateUserId, 'vectors')
      : path.join(guildDir(guildId), 'vectors');
  }

  const genFile = (dir, gen, ext) => path.join(dir, `${gen}.${ext}`);

  async function listDir(dir) {
    try {
      return (await fs.readdir(dir)).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function months(base) {
    return (await listDir(base)).filter((name) => MONTH_RE.test(name));
  }

  async function readManifest(dir) {
    let text;
    try {
      text = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return validManifest(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Write `data` to `file` through `<file>.tmp`, fsynced, then rename. */
  async function writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    const fd = await fs.open(tmp, 'w');
    try {
      await fd.write(data);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.rename(tmp, file);
  }

  async function appendBytes(file, data) {
    const fd = await fs.open(file, 'a');
    try {
      await fd.write(data);
      await fd.sync();
    } finally {
      await fd.close();
    }
  }

  /** `length` bytes of `file` from `position`. */
  async function readBytes(file, position, length) {
    const buf = Buffer.alloc(length);
    if (length === 0) return buf;
    const fd = await fs.open(file, 'r');
    try {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fd.read(buf, read, length - read, position + read);
        if (bytesRead === 0) {
          const error = new Error('vectors: file shorter than its manifest');
          error.code = 'vectors-short';
          throw error;
        }
        read += bytesRead;
      }
    } finally {
      await fd.close();
    }
    return buf;
  }

  /** Cut `file` back to `length` bytes (a crash's leftovers); a missing or shorter file is an error. */
  async function cutTo(file, length, month) {
    let size = 0;
    try {
      size = (await fs.stat(file)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (size < length) {
      const error = new Error('vectors: file shorter than its manifest');
      error.code = 'vectors-short';
      throw error;
    }
    if (size > length) {
      await fs.truncate(file, length);
      log.warn('vectors: tail cut', { month, bytes: size - length });
    }
  }

  function dropCached(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.size;
    cache.delete(key);
  }

  function dropCachedUnder(prefix) {
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) dropCached(key);
  }

  function remember(key, entry) {
    dropCached(key);
    cache.set(key, entry);
    cachedBytes += entry.size;
    for (const other of cache.keys()) {
      if (cachedBytes <= maxCacheBytes) break;
      if (other !== key) dropCached(other);
    }
  }

  /** The parsed jsonl lines of `buf` (a line that does not parse becomes null). */
  function parseLines(buf) {
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

  /**
   * A month as the manifest names it: the cached copy, its tail read when the generation grew, or
   * the whole generation. Null when the month is empty, missing or fails its checksum.
   */
  async function loadMonth(base, month, retried = false) {
    const key = `${base}|${month}`;
    const dir = path.join(base, month);
    const manifest = await readManifest(dir);
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
    const grows = cached && cached.gen === manifest.gen && cached.dims === manifest.dims && cached.rows < manifest.rows;
    const fromBytes = grows ? cached.bytes : 0;
    const fromMeta = grows ? cached.metaBytes : 0;
    let dataBuf;
    let metaBuf;
    try {
      dataBuf = await readBytes(genFile(dir, manifest.gen, 'i8'), fromBytes, manifest.bytes - fromBytes);
      metaBuf = await readBytes(genFile(dir, manifest.gen, 'jsonl'), fromMeta, manifest.metaBytes - fromMeta);
    } catch (error) {
      // A rewrite switched the generation between the manifest and the files: read it again.
      if (error?.code === 'ENOENT' && !retried) return loadMonth(base, month, true);
      if (error?.code === 'ENOENT' || error?.code === 'vectors-short') {
        log.warn('vectors: month unreadable', { month, code: error.code });
        dropCached(key);
        return null;
      }
      throw error;
    }
    const hashes = [fnv(grows ? cached.hashes[0] : FNV_OFFSET, dataBuf), fnv(grows ? cached.hashes[1] : FNV_OFFSET, metaBuf)];
    if (checksumOf(...hashes) !== manifest.checksum) {
      log.warn('vectors: checksum mismatch', { month, gen: manifest.gen });
      dropCached(key);
      return null;
    }
    const tail = parseLines(metaBuf);
    const metas = grows ? cached.metas.concat(tail) : tail;
    if (metas.length !== manifest.rows) {
      log.warn('vectors: month unreadable', { month, code: 'row-count' });
      dropCached(key);
      return null;
    }
    let data;
    if (grows) {
      data = new Int8Array(manifest.bytes);
      data.set(cached.data, 0);
      data.set(new Int8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length), cached.bytes);
    } else {
      data = new Int8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length);
    }
    const entry = {
      gen: manifest.gen, rows: manifest.rows, dims: manifest.dims, bytes: manifest.bytes, metaBytes: manifest.metaBytes,
      data, metas, hashes, size: manifest.bytes + manifest.metaBytes,
    };
    remember(key, entry);
    return entry;
  }

  /** The month of an ISO time (`now` when unreadable) and the ISO time itself. */
  function placed(occurredAt) {
    const iso = isoOf(occurredAt) ?? new Date(now()).toISOString();
    return { iso, month: iso.slice(0, 7) };
  }

  /** The stored line of a row: the whitelisted meta fields, its index, scale and norm. */
  function storedMeta(meta, row, iso, scale, norm) {
    const source = meta && typeof meta === 'object' ? meta : {};
    return {
      row,
      kind: source.kind === 'archive' ? 'archive' : 'record',
      id: typeof source.id === 'string' ? source.id : String(source.id ?? ''),
      revision: source.revision ?? null,
      occurredAt: iso,
      channelId: typeof source.channelId === 'string' && source.channelId ? source.channelId : null,
      by: typeof source.by === 'string' && source.by ? source.by : null,
      participants: idList(source.participants),
      sourceIds: idList(source.sourceIds),
      scale,
      norm,
    };
  }

  function shapeError(month) {
    const error = new Error(`vectors: month ${month} holds rows of another model or length`);
    error.code = 'vectors-shape';
    return error;
  }

  async function appendMonth(base, month, items, dims, model) {
    const dir = path.join(base, month);
    await fs.mkdir(dir, { recursive: true });
    const current = await readManifest(dir);
    let manifest = current ?? {
      v: MANIFEST_VERSION, gen: 1, rows: 0, bytes: 0, metaBytes: 0, model: model ?? null, dims, checksum: checksumOf(FNV_OFFSET, FNV_OFFSET),
    };
    if (manifest.rows > 0 && (manifest.dims !== dims || (model && manifest.model && model !== manifest.model))) throw shapeError(month);
    if (manifest.rows === 0) manifest = { ...manifest, dims, model: model ?? manifest.model ?? null };
    const hashes = parseChecksum(manifest.checksum) ?? [FNV_OFFSET, FNV_OFFSET];
    const i8File = genFile(dir, manifest.gen, 'i8');
    const metaFile = genFile(dir, manifest.gen, 'jsonl');
    await cutTo(i8File, manifest.bytes, month);
    await cutTo(metaFile, manifest.metaBytes, month);
    const data = Buffer.alloc(items.length * dims);
    let lines = '';
    items.forEach(({ quantized, meta, iso }, i) => {
      data.set(quantized.bytes, i * dims);
      lines += `${JSON.stringify(storedMeta(meta, manifest.rows + i, iso, quantized.scale, quantized.norm))}\n`;
    });
    const metaBuf = Buffer.from(lines, 'utf8');
    await appendBytes(i8File, data);
    await appendBytes(metaFile, metaBuf);
    const next = {
      ...manifest,
      v: MANIFEST_VERSION,
      rows: manifest.rows + items.length,
      bytes: manifest.bytes + data.length,
      metaBytes: manifest.metaBytes + metaBuf.length,
      checksum: checksumOf(fnv(hashes[0], data), fnv(hashes[1], metaBuf)),
    };
    await writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(next));
  }

  async function append(guildId, rows, { privateUserId = null, model = null } = {}) {
    // Outside the chain: a forget queued behind a held append would wait for itself.
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && row.vector);
      if (list.length === 0) return { written: 0 };
      const dims = list[0].vector.length;
      if (!Number.isInteger(dims) || dims < 1) throw new TypeError('vectors: an empty vector');
      const byMonth = new Map();
      for (const row of list) {
        if (row.vector.length !== dims) throw new TypeError('vectors: vectors of one append differ in length');
        const { iso, month } = placed(row.meta?.occurredAt);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push({ quantized: quantize(row.vector), meta: row.meta, iso });
      }
      const base = baseDir(guildId, privateUserId);
      for (const [month, items] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
        await appendMonth(base, month, items, dims, model);
      }
      log.info('vectors: appended', { guildId: String(guildId), rows: list.length, months: byMonth.size });
      return { written: list.length };
    });
  }

  /** Rewrite one month into a new generation with the rows `keep` accepts; the old ones deleted. */
  async function rewriteMonth(base, month, keep) {
    const key = `${base}|${month}`;
    const dir = path.join(base, month);
    const manifest = await readManifest(dir);
    if (!manifest || manifest.rows === 0) return { kept: 0, dropped: 0 };
    const data = await readBytes(genFile(dir, manifest.gen, 'i8'), 0, manifest.bytes);
    const metas = parseLines(await readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes));
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
    await writeAtomic(genFile(dir, gen, 'i8'), out);
    await writeAtomic(genFile(dir, gen, 'jsonl'), metaBuf);
    await writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      v: MANIFEST_VERSION,
      gen,
      rows: keptRows.length,
      bytes: out.length,
      metaBytes: metaBuf.length,
      checksum: checksumOf(fnv(FNV_OFFSET, out), fnv(FNV_OFFSET, metaBuf)),
    }));
    dropCached(key);
    // Every other generation goes: the one just replaced and any a crashed rewrite left behind.
    for (const name of await listDir(dir)) {
      const match = name.match(GEN_FILE_RE);
      if (match && Number(match[1]) !== gen) await fs.rm(path.join(dir, name), { force: true });
    }
    return { kept: keptRows.length, dropped };
  }

  async function rewrite(guildId, month, keep, { privateUserId = null } = {}) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const result = await rewriteMonth(baseDir(guildId, privateUserId), String(month), keep);
      if (result.dropped > 0) log.info('vectors: rewritten', { guildId: String(guildId), month, ...result });
      return result;
    });
  }

  /**
   * One month built anew: `items` (quantised, all of `month`) plus the current generation's rows
   * `keep` accepts (none when they are of another length or model), written as the next
   * generation, the manifest switched by rename, the older generations deleted.
   */
  async function replaceMonth(base, month, items, dims, model, keep) {
    const key = `${base}|${month}`;
    const dir = path.join(base, month);
    await fs.mkdir(dir, { recursive: true });
    const manifest = await readManifest(dir);
    const kept = [];
    if (manifest && manifest.rows > 0 && typeof keep === 'function' && manifest.dims === dims && !(model && manifest.model && model !== manifest.model)) {
      const data = await readBytes(genFile(dir, manifest.gen, 'i8'), 0, manifest.bytes);
      const metas = parseLines(await readBytes(genFile(dir, manifest.gen, 'jsonl'), 0, manifest.metaBytes));
      for (let row = 0; row < manifest.rows; row += 1) {
        if (metas[row] && keep(metas[row])) kept.push({ meta: metas[row], bytes: data.subarray(row * dims, (row + 1) * dims) });
      }
    }
    const gen = (manifest?.gen ?? 0) + 1;
    const rows = items.length + kept.length;
    const out = Buffer.alloc(rows * dims);
    let lines = '';
    items.forEach(({ quantized, meta, iso }, i) => {
      out.set(quantized.bytes, i * dims);
      lines += `${JSON.stringify(storedMeta(meta, i, iso, quantized.scale, quantized.norm))}\n`;
    });
    kept.forEach(({ meta, bytes }, j) => {
      const row = items.length + j;
      out.set(bytes, row * dims);
      lines += `${JSON.stringify({ ...meta, row })}\n`;
    });
    const metaBuf = Buffer.from(lines, 'utf8');
    await writeAtomic(genFile(dir, gen, 'i8'), out);
    await writeAtomic(genFile(dir, gen, 'jsonl'), metaBuf);
    await writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify({
      v: MANIFEST_VERSION,
      gen,
      rows,
      bytes: out.length,
      metaBytes: metaBuf.length,
      model: model ?? manifest?.model ?? null,
      dims,
      checksum: checksumOf(fnv(FNV_OFFSET, out), fnv(FNV_OFFSET, metaBuf)),
    }));
    dropCached(key);
    for (const name of await listDir(dir)) {
      const match = name.match(GEN_FILE_RE);
      if (match && Number(match[1]) !== gen) await fs.rm(path.join(dir, name), { force: true });
    }
    return { written: items.length, kept: kept.length, dropped: (manifest?.rows ?? 0) - kept.length };
  }

  async function replace(guildId, month, rows, { privateUserId = null, model = null, keep = null } = {}) {
    if (!MONTH_RE.test(String(month))) throw new TypeError('vectors: month must be YYYY-MM');
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && row.vector);
      if (list.length === 0) return { written: 0, kept: 0, dropped: 0 };
      const dims = list[0].vector.length;
      if (!Number.isInteger(dims) || dims < 1) throw new TypeError('vectors: an empty vector');
      const items = list.map((row) => {
        if (row.vector.length !== dims) throw new TypeError('vectors: vectors of one replace differ in length');
        const { iso, month: rowMonth } = placed(row.meta?.occurredAt);
        if (rowMonth !== String(month)) throw new TypeError(`vectors: a row of ${rowMonth} in a replace of ${month}`);
        return { quantized: quantize(row.vector), meta: row.meta, iso };
      });
      const result = await replaceMonth(baseDir(guildId, privateUserId), String(month), items, dims, model, keep);
      log.info('vectors: replaced', { guildId: String(guildId), month: String(month), ...result });
      return result;
    });
  }

  /** The user ids with a private layer in the guild. */
  async function privateUsers(guildId) {
    return listDir(path.join(guildDir(guildId), 'private'));
  }

  function forgetUser(guildId, userId, { before = null, messageIds = null } = {}) {
    return serial(async () => {
      const id = String(userId);
      const timed = Number.isFinite(before);
      const sources = messageIds ? new Set([...messageIds].map(String)) : null;
      const marker = path.join(guildDir(guildId), 'forgetting', `${id}.json`);
      let created = false;
      if (!timed) {
        try {
          await fs.stat(marker);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          await fs.mkdir(path.dirname(marker), { recursive: true });
          await fs.writeFile(marker, JSON.stringify({ userId: id, at: new Date(now()).toISOString(), step: 'vectors' }));
          created = true;
        }
      }
      const keep = (meta) => !rowDrops(meta, id, timed ? before : null, sources);
      let dropped = 0;
      let privateDropped = 0;
      const guildBase = baseDir(guildId);
      for (const month of await months(guildBase)) dropped += (await rewriteMonth(guildBase, month, keep)).dropped;
      for (const other of await privateUsers(guildId)) {
        const base = baseDir(guildId, other);
        if (other === id && !timed) {
          // The member's own private index goes whole.
          for (const month of await months(base)) privateDropped += (await readManifest(path.join(base, month)))?.rows ?? 0;
          await fs.rm(base, { recursive: true, force: true });
          dropCachedUnder(`${base}|`);
          continue;
        }
        const test = other === id ? (meta) => !earlier(meta, before) : keep;
        for (const month of await months(base)) privateDropped += (await rewriteMonth(base, month, test)).dropped;
      }
      if (created) await fs.rm(marker, { force: true });
      log.info('vectors: forgotten', { guildId: String(guildId), dropped, privateDropped });
      return { dropped, privateDropped };
    });
  }

  /** The forgotten members of the guild: user id -> their latest ledger time (epoch ms). */
  function ledgerTimes(guildId) {
    const latest = new Map();
    for (const entry of readLedger(dataDir, guildId)) {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at)) continue;
      if (!(latest.get(entry.userId) >= at)) latest.set(entry.userId, at);
    }
    return latest;
  }

  /** Push `item` into the min-heap `heap` of at most `k` items by score. */
  function offer(heap, k, item) {
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

  async function search(guildId, query, { months: asked = null, from = null, to = null, filter = null, k = 10, privateUserId = null } = {}) {
    const limit = Number.isInteger(k) && k > 0 ? k : 0;
    if (!limit || !query?.length) return [];
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    let qq = 0;
    for (let i = 0; i < q.length; i += 1) qq += q[i] * q[i];
    const qNorm = Math.sqrt(qq);
    if (!(qNorm > 0)) return [];
    const hidden = [...(await forgettingIds(fs, dataDir, guildId))];
    const ledger = ledgerTimes(guildId);
    const isPrivate = typeof privateUserId === 'string' && privateUserId;
    if (isPrivate && hidden.includes(privateUserId)) return [];
    const ownLedger = isPrivate ? ledger.get(privateUserId) : undefined;
    const fromIso = from === null || from === undefined ? null : isoOf(from);
    const toIso = to === null || to === undefined ? null : isoOf(to);
    const fromMs = fromIso ? Date.parse(fromIso) : -Infinity;
    const toMs = toIso ? Date.parse(toIso) : Infinity;
    const wanted = Array.isArray(asked) ? new Set(asked) : null;
    const base = baseDir(guildId, privateUserId);
    const heap = [];
    for (const month of await months(base)) {
      if (wanted && !wanted.has(month)) continue;
      if ((fromIso && month < fromIso.slice(0, 7)) || (toIso && month > toIso.slice(0, 7))) continue;
      const entry = await loadMonth(base, month);
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
        if (Number.isFinite(at) && (at < fromMs || at > toMs)) continue;
        if (hidden.length > 0 && hidden.some((id) => rowDrops(meta, id))) continue;
        if (ownLedger !== undefined && earlier(meta, ownLedger)) continue;
        if (ledger.size > 0) {
          let gone = false;
          for (const [id, before] of ledger) if (rowDrops(meta, id, before)) { gone = true; break; }
          if (gone) continue;
        }
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

  async function stats(guildId, { privateUserId = null } = {}) {
    const base = baseDir(guildId, privateUserId);
    let count = 0;
    let rows = 0;
    let bytes = 0;
    for (const month of await months(base)) {
      const manifest = await readManifest(path.join(base, month));
      if (!manifest) continue;
      count += 1;
      rows += manifest.rows;
      bytes += manifest.bytes + manifest.metaBytes;
    }
    return { months: count, rows, bytes };
  }

  return { append, rewrite, replace, forgetUser, search, stats };
}
