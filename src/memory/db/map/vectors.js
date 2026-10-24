// Mapper: one month of the vector index (`vectors/<YYYY-MM>/`, or a private layer's) <-> `vectors` rows and one
// `operational` row. The month is three files kept together by the engine, so the mapper's value is all three:
//
//   value = { manifest: <parsed manifest.json>, meta: <text of <gen>.jsonl>, i8: <Buffer of <gen>.i8> }
//
//   vectors      one row per complete line of the jsonl: `bytes` is the row's `dims` int8 bytes as a BLOB, `scale`,
//                `norm`, `item_id` (the line's id), `occurred_at` are columns, `model` and `dims` come from the
//                manifest, `chunk_key` is the engine's `<kind>:<id>:<revision>` (prefixed `private:<user>:` in a
//                private layer, suffixed `#2`... if a month repeats one), and `context` holds the other fields of
//                the line (row, kind, revision, channelId, by, participants, sourceIds, unknown ones), plus `$keys`
//                when the line's key order is not the engine's own. `source_rowid` is left NULL: sync links it.
//   operational  kind vectors: `{ manifest, gen, tailI8?, raw? }`. `tailI8` is the bytes (base64) after the last
//                row's, which the manifest does not count; `raw` is set (and no vectors rows are made) when the jsonl is
//                not a clean list of lines the engine itself would have written, so the files still come back exact.
//
// fromRows gives `{ manifest, meta, i8 }` back, and `filesOf(rel, value)` lists the three files to write.
//
// toRows(rel, value, ctx) -> { vectors, operational }     fromRows(rows, ctx) -> the value

import { personId, uniqueIds } from '../ids.js';
import { dmScope, groupScope } from '../scope.js';
import { extraText, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.js';
import { privateUserOf } from './scope-parts.js';

const SPEC = [
  { col: 'item_id', key: 'id', type: 'text' },
  { col: 'occurred_at', key: 'occurredAt', type: 'text' },
  { col: 'scale', key: 'scale', type: 'num' },
  { col: 'norm', key: 'norm', type: 'num' },
];

/** The key order the engine writes a vector line in; keys it does not know follow in their own order. */
const CANONICAL = ['row', 'kind', 'id', 'revision', 'occurredAt', 'channelId', 'by', 'participants', 'sourceIds', 'scale', 'norm'];

const sameOrder = (a, b) => a.length === b.length && a.every((key, index) => key === b[index]);

function canonicalOrder(keys) {
  return [...CANONICAL.filter((key) => keys.includes(key)), ...keys.filter((key) => !CANONICAL.includes(key))];
}

/** `vectors/<month>` of the files `vectors/<month>/...` (a private layer keeps its prefix). */
export function monthDirOf(rel) {
  return String(rel).replace(/\/(?:manifest\.json|\d+\.(?:i8|jsonl))$/, '');
}

const chunkKeyOf = (line, prefix) => `${prefix}${line.kind === 'archive' ? 'archive' : 'record'}:${line.id ?? ''}:${line.revision ?? ''}`;

/** The meta lines of a jsonl text when it is clean (every line complete, parseable, and re-written identically). */
function cleanLines(text) {
  if (text === '') return [];
  if (!text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  const parsed = [];
  for (const line of lines) {
    let value;
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

export function toRows(rel, value) {
  const dir = monthDirOf(rel);
  const user = privateUserOf(dir);
  const scope = user ? dmScope(personId(user)) : groupScope();
  const manifest = value.manifest;
  const meta = Buffer.isBuffer(value.meta) ? value.meta.toString('utf8') : String(value.meta ?? '');
  const i8 = Buffer.from(value.i8 ?? []);
  const rows = {};
  const operational = { manifest, gen: manifest?.gen ?? null };
  const lines = cleanLines(meta);
  const dims = Number.isInteger(manifest?.dims) && manifest.dims > 0 ? manifest.dims : null;
  if (lines === null || dims === null) {
    operational.raw = { meta, i8: i8.toString('base64') };
  } else {
    const uniq = uniqueIds();
    const prefix = user ? `private:${user}:` : '';
    lines.forEach((line, index) => {
      const keys = Object.keys(line);
      const part = split(line, SPEC);
      if (!sameOrder(keys, canonicalOrder(keys))) part.rest.$keys = keys;
      put(rows, 'vectors', {
        source_rowid: null,
        ...part.cols,
        chunk_key: uniq(chunkKeyOf(line, prefix)),
        model: typeof manifest.model === 'string' ? manifest.model : null,
        dims,
        bytes: i8.subarray(index * dims, (index + 1) * dims),
        context: extraText(part.rest),
        ...scope,
      });
    });
    const used = lines.length * dims;
    if (i8.length > used) operational.tailI8 = i8.subarray(used).toString('base64');
  }
  put(rows, 'operational', { kind: 'vectors', owner: dir, value: JSON.stringify(operational), owner_file: dir });
  return rows;
}

/** Puts a line's keys in the order it was written in. */
function inOrder(line, keys) {
  if (!Array.isArray(keys)) return line;
  const out = {};
  for (const key of keys) if (Object.hasOwn(line, key)) out[key] = line[key];
  for (const key of Object.keys(line)) if (!Object.hasOwn(out, key)) out[key] = line[key];
  return out;
}

export function fromRows(rows) {
  const operational = JSON.parse(rowsOf(rows, 'operational')[0].value);
  if (operational.raw) {
    return { manifest: operational.manifest, meta: operational.raw.meta, i8: Buffer.from(operational.raw.i8, 'base64') };
  }
  const lines = [];
  const chunks = [];
  const vectors = rowsOf(rows, 'vectors')
    .map((row, index) => ({ row, index, order: Number(parseExtra(row.context).row) }))
    .sort((a, b) => (Number.isFinite(a.order) && Number.isFinite(b.order) ? a.order - b.order : 0) || a.index - b.index);
  for (const { row } of vectors) {
    const context = parseExtra(row.context);
    const keys = context.$keys;
    delete context.$keys;
    const line = join(row, context, SPEC);
    lines.push(JSON.stringify(inOrder(canonicalFirst(line), keys)));
    chunks.push(Buffer.from(row.bytes));
  }
  if (operational.tailI8) chunks.push(Buffer.from(operational.tailI8, 'base64'));
  return { manifest: operational.manifest, meta: lines.map((line) => `${line}\n`).join(''), i8: Buffer.concat(chunks) };
}

function canonicalFirst(line) {
  return inOrder(line, canonicalOrder(Object.keys(line)));
}

/** The files of a month to write: `[{ rel, data }]` (the manifest as the engine writes it, then the data). */
export function filesOf(rel, value) {
  const dir = monthDirOf(rel);
  const gen = value.manifest?.gen;
  return [
    { rel: `${dir}/manifest.json`, data: Buffer.from(JSON.stringify(value.manifest)) },
    { rel: `${dir}/${gen}.i8`, data: Buffer.from(value.i8) },
    { rel: `${dir}/${gen}.jsonl`, data: Buffer.from(value.meta, 'utf8') },
  ];
}
