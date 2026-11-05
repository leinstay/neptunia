// Mapper: one month of the vector index (`vectors/<YYYY-MM>/`, or a private layer's) <-> `vectors` rows and one
// `operational` row. The month is three files kept together by the engine, so the mapper's value is all three:
//
//   value = { manifest: <parsed manifest.json>, meta: <text of <gen>.jsonl>, i8: <Buffer of <gen>.i8> }
//
//   vectors      one row per complete line of the jsonl: `bytes` is the row's `dims` int8 bytes as a BLOB, `scale`,
//                `norm`, `item_id` (the line's id), `occurred_at` are columns, `model` and `dims` come from the
//                manifest, `chunk_key` is the engine's `<kind>:<id>:<revision>` (prefixed `private:<user>:` in a
//                private layer, suffixed `#2`... if a month repeats one), and `context` holds the other fields of
//                the line (row, kind, revision, placeId, by, participants, sourceIds, unknown ones), plus `$keys`
//                when the line's key order is not the engine's own. `source_rowid` is left NULL: sync links it.
//   operational  kind vectors: `{ manifest, gen, tailI8?, raw? }`. `tailI8` is the bytes (base64) after the last
//                row's, which the manifest does not count; `raw` is set (and no vectors rows are made) when the jsonl is
//                not a clean list of lines the engine itself would have written, so the files still come back exact.
//
// fromRows gives `{ manifest, meta, i8 }` back, and `filesOf(rel, value)` lists the three files to write.
//
// toRows(rel, value, ctx) -> { vectors, operational }     fromRows(rows, ctx) -> the value

import { personId, uniqueIds } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { dmScope, groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.ts';
import { dmPlaceScope, privateUserOf } from './scope-parts.ts';
import { asText } from '../types.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

const SPEC: Array<Spec> = [
  { col: 'item_id', key: 'id', type: 'text' },
  { col: 'occurred_at', key: 'occurredAt', type: 'text' },
  { col: 'scale', key: 'scale', type: 'num' },
  { col: 'norm', key: 'norm', type: 'num' },
];

/** The key order the engine writes a vector line in; keys it does not know follow in their own order. */
const CANONICAL = [
  'row',
  'kind',
  'id',
  'revision',
  'occurredAt',
  'placeId',
  'by',
  'participants',
  'sourceIds',
  'scale',
  'norm',
];

/** The manifest of a month: its generation, the vector size, the model and the number of rows. */
type Manifest = { gen?: unknown; dims?: number; model?: unknown; rows?: number; [key: string]: unknown };

/** The files of a month as the engine holds them: the manifest, the jsonl text and the int8 bytes. */
type MonthFiles = { manifest: Manifest; meta: string | Buffer; i8: ArrayLike<number> | undefined };

/** What a month's rows need from the month: its manifest, bytes, scope and the chunk key dedup. */
type MonthContext = {
  manifest: Manifest;
  dims: number;
  i8: Buffer;
  prefix: string;
  unique: (id: string) => string;
  scope: Row;
};

/** The operational value a month leaves beside its rows. */
type Stored = {
  manifest: Manifest;
  gen: unknown;
  raw?: { meta: string; i8: string };
  tailI8?: string;
};

const sameOrder = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index]);

function canonicalOrder(keys: ReadonlyArray<string>): Array<string> {
  return [...CANONICAL.filter((key) => keys.includes(key)), ...keys.filter((key) => !CANONICAL.includes(key))];
}

/** `vectors/<month>` of the files `vectors/<month>/...` (a private layer keeps its prefix). */
export function monthDirOf(rel: string): string {
  return String(rel).replace(/\/(?:manifest\.json|\d+\.(?:i8|jsonl))$/, '');
}

const chunkKeyOf = (line: Row, prefix: string): string =>
  `${prefix}${line.kind === 'archive' ? 'archive' : 'record'}:${asText(line.id ?? '')}:${asText(line.revision ?? '')}`;

/** The meta lines of a jsonl text when it is clean (every line complete, parseable, and re-written identically). */
function cleanLines(text: string): Array<Row> | null {
  if (text === '') return [];
  if (!text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  const parsed: Array<Row> = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isPlainObject(value) || JSON.stringify(value) !== line) return null;
    parsed.push(value);
  }
  return parsed;
}

/** The `vectors` row of one clean jsonl line; `index` is its position in the month, `unique` the month's chunk_key dedup. */
function lineRow(line: Row, index: number, ctx: MonthContext): Row {
  const { manifest, dims, i8, prefix, unique, scope } = ctx;
  const keys = Object.keys(line);
  const part = split(line, SPEC);
  if (!sameOrder(keys, canonicalOrder(keys))) part.rest.$keys = keys;
  return {
    source_rowid: null,
    ...part.cols,
    chunk_key: unique(chunkKeyOf(line, prefix)),
    model: typeof manifest.model === 'string' ? manifest.model : null,
    dims,
    bytes: i8.subarray(index * dims, (index + 1) * dims),
    context: extraText(part.rest),
    ...scope,
  };
}

function monthContext(
  dir: string,
  manifest: Manifest,
  i8: Buffer,
  unique: (id: string) => string,
  iface: string,
  privateUser: string | null | undefined = undefined,
  dmPlace: MapContext['dmPlace'] = null
): MonthContext {
  const user = privateUser ?? privateUserOf(dir);
  const dm = (user: string): Row =>
    dmPlace ? dmPlaceScope(personId(iface, user), iface, dmPlace) : dmScope(personId(iface, user), iface);
  return {
    manifest,
    i8,
    unique,
    dims: manifest.dims as number, // the caller checked that the manifest has a positive `dims`
    prefix: user ? `private:${user}:` : '',
    scope: user ? dm(user) : groupScope(iface),
  };
}

const metaText = (value: Pick<MonthFiles, 'meta'>): string =>
  Buffer.isBuffer(value.meta) ? value.meta.toString('utf8') : String(value.meta ?? '');

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const files = value as MonthFiles; // a month's files: the engine reads them as a manifest, jsonl text and int8 bytes
  const iface = ifaceOf(ctx);
  const dir = monthDirOf(rel);
  const manifest = files.manifest;
  const meta = metaText(files);
  const i8 = Buffer.from(files.i8 ?? []);
  const rows: Rows = {};
  const operational: Stored = { manifest, gen: manifest?.gen ?? null };
  const lines = cleanLines(meta);
  const dims = Number.isInteger(manifest?.dims) && (manifest.dims as number) > 0 ? (manifest.dims as number) : null;
  if (lines === null || dims === null) {
    operational.raw = { meta, i8: i8.toString('base64') };
  } else {
    const month = monthContext(dir, manifest, i8, uniqueIds(), iface, ctx.privateUserId, ctx.dmPlace);
    lines.forEach((line, index) => put(rows, 'vectors', lineRow(line, index, month)));
    const used = lines.length * dims;
    if (i8.length > used) operational.tailI8 = i8.subarray(used).toString('base64');
  }
  put(rows, 'operational', { kind: 'vectors', owner: dir, value: JSON.stringify(operational), owner_file: dir });
  return rows;
}

/**
 * The part of a month that came after the rows already stored, as rows: for a month whose generation is the same and
 * whose files only grew. `previous` is the stored operational value (parsed) and `keys` the chunk_keys already in
 * the month. Returns null when the stored state cannot be extended (a raw month, a counted tail, a changed shape, a
 * delta that is not clean lines, a row count that does not add up); the caller then maps the month whole.
 * `delta` is the jsonl text and the int8 bytes from the stored `metaBytes` and `bytes` on (to the end of each file),
 * with the new manifest.
 */
export function appendRows(
  rel: string,
  delta: MonthFiles,
  {
    previous,
    keys,
    iface = LEGACY_IFACE,
    privateUserId,
    dmPlace = null,
  }: {
    previous: Stored;
    keys: Iterable<string>;
    iface?: string;
    privateUserId?: string | null;
    dmPlace?: MapContext['dmPlace'];
  }
): Rows | null {
  const dir = monthDirOf(rel);
  const manifest = delta.manifest;
  const old = previous?.manifest;
  if (!old || previous.raw || previous.tailI8 || !Number.isInteger(manifest?.dims) || (manifest.dims as number) <= 0)
    return null;
  const dims = manifest.dims as number;
  if (
    old.gen !== manifest.gen ||
    old.dims !== manifest.dims ||
    old.model !== manifest.model ||
    (manifest.rows as number) <= (old.rows as number)
  )
    return null;
  const lines = cleanLines(metaText(delta));
  if (lines === null || lines.length !== (manifest.rows as number) - (old.rows as number)) return null;
  const i8 = Buffer.from(delta.i8 ?? []);
  if (i8.length < lines.length * dims) return null;
  const seen = new Set(keys);
  const unique = (id: string) => {
    let n = 1;
    let out = id;
    while (seen.has(out)) {
      n += 1;
      out = `${id}-${n}`;
    }
    seen.add(out);
    return out;
  };
  const month = monthContext(dir, manifest, i8, unique, iface, privateUserId, dmPlace);
  const rows: Rows = {};
  lines.forEach((line, index) => put(rows, 'vectors', lineRow(line, index, month)));
  const next: Stored = { manifest, gen: manifest.gen ?? null };
  const used = lines.length * dims;
  if (i8.length > used) next.tailI8 = i8.subarray(used).toString('base64');
  put(rows, 'operational', { kind: 'vectors', owner: dir, value: JSON.stringify(next), owner_file: dir });
  return rows;
}

/** Puts a line's keys in the order it was written in. */
function inOrder(line: Row, keys: unknown): Row {
  if (!Array.isArray(keys)) return line;
  const out: Row = {};
  for (const key of keys) if (Object.hasOwn(line, key)) out[key] = line[key];
  for (const key of Object.keys(line)) if (!Object.hasOwn(out, key)) out[key] = line[key];
  return out;
}

export function fromRows(rows: Rows): Row {
  const operational = JSON.parse(String(rowsOf(rows, 'operational')[0].value)) as Stored;
  if (operational.raw) {
    return {
      manifest: operational.manifest,
      meta: operational.raw.meta,
      i8: Buffer.from(operational.raw.i8, 'base64'),
    };
  }
  const lines: Array<string> = [];
  const chunks: Array<Buffer> = [];
  const vectors = rowsOf(rows, 'vectors')
    .map((row, index) => ({ row, index, order: Number(parseExtra(row.context).row) }))
    .sort(
      (a, b) => (Number.isFinite(a.order) && Number.isFinite(b.order) ? a.order - b.order : 0) || a.index - b.index
    );
  for (const { row } of vectors) {
    const context = parseExtra(row.context);
    const keys = context.$keys;
    delete context.$keys;
    const line = join(row, context, SPEC);
    lines.push(JSON.stringify(inOrder(canonicalFirst(line), keys)));
    chunks.push(Buffer.from(row.bytes as Uint8Array));
  }
  if (operational.tailI8) chunks.push(Buffer.from(operational.tailI8, 'base64'));
  return { manifest: operational.manifest, meta: lines.map((line) => `${line}\n`).join(''), i8: Buffer.concat(chunks) };
}

function canonicalFirst(line: Row): Row {
  return inOrder(line, canonicalOrder(Object.keys(line)));
}

/** The files of a month to write: `[{ rel, data }]` (the manifest as the engine writes it, then the data). */
export function filesOf(rel: string, value: Row): Array<{ rel: string; data: Buffer }> {
  const files = value as MonthFiles;
  const dir = monthDirOf(rel);
  const gen = files.manifest?.gen;
  return [
    { rel: `${dir}/manifest.json`, data: Buffer.from(JSON.stringify(files.manifest)) },
    { rel: `${dir}/${asText(gen)}.i8`, data: Buffer.from(files.i8 as ArrayLike<number>) },
    { rel: `${dir}/${asText(gen)}.jsonl`, data: Buffer.from(files.meta as string, 'utf8') },
  ];
}
