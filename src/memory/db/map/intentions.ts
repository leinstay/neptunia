// Mapper: `intentions.json` (`{ intentions: [...] }`) and `intentions-archive.jsonl` (one closed record per line) <->
// `intentions` rows, and `operational` (kind intentions) for the rest of intentions.json.
//
// The `record` column holds the old record verbatim and is the authority; the other columns (status, due_ms,
// created_ms, updated_ms, the scope) are copies of its fields, there so a query can filter without parsing the JSON.
// `archived` is 1 for a line of the archive file. The scope is the record's `provenance.scope`: 'dm' with one
// participant is that member's DM scope, 'dm' otherwise is internal, anything else is group (scope-string.ts).
//
// toRows(rel, valueOrLine, ctx) -> { intentions, operational? }     ctx: { position? } (archive lines)
// fromRows(rows, ctx) -> the file's value, or the archive line

import { isPlainObject, ordered, parseExtra, put, rowsOf } from './common.ts';
import { stringScope } from './scope-string.ts';
import { isFiniteNumber } from '../types.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext } from './common.ts';

const num = (value: unknown) => (isFiniteNumber(value) ? value : null);
const text = (value: unknown) => (typeof value === 'string' ? value : null);

export const isArchivePath = (rel: string): boolean => /intentions-archive\.jsonl$/.test(String(rel));

function rowOf(rel: string, record: Row, position: number, archived: unknown, ctx: MapContext): Row {
  const provenance = record.provenance as { scope?: unknown; participants?: ReadonlyArray<unknown> } | undefined;
  return {
    id: record.id,
    record: JSON.stringify(record),
    status: text(record.status),
    due_ms: num(record.dueAt),
    created_ms: num(record.createdAt),
    updated_ms: num(record.updatedAt),
    ...stringScope(provenance?.scope, provenance?.participants, undefined, ctx),
    archived: archived ? 1 : 0,
    owner_file: rel,
    position: position ?? null,
  };
}

const mappable = (record: Row) => isPlainObject(record) && typeof record.id === 'string' && record.id !== '';

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const rows: Rows = {};
  if (ctx.collection === 'archive' || isArchivePath(rel)) {
    // A line that is not a record with an id cannot be keyed: it is kept as a record under a derived id.
    const record = mappable(value) ? value : { id: `archive-line-${ctx.position ?? 0}`, $raw: value };
    put(rows, 'intentions', rowOf(rel, record, ctx.position ?? 0, true, ctx));
    return rows;
  }
  const rest = { ...value };
  const list = value.intentions;
  const ids = Array.isArray(list) ? list.map((record) => record?.id) : [];
  if (Array.isArray(list) && list.every(mappable) && new Set(ids).size === ids.length) {
    list.forEach((record, position) => put(rows, 'intentions', rowOf(rel, record, position, false, ctx)));
    delete rest.intentions;
    rest.$has = ['intentions'];
  } else {
    rest.$has = [];
  }
  put(rows, 'operational', { kind: 'intentions', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows: Rows, ctx: MapContext = {}): unknown {
  const records = ordered(rows, 'intentions').map((row) => JSON.parse(String(row.record)));
  if (rowsOf(rows, 'operational').length === 0) {
    const record = records[0];
    return isPlainObject(record) && Object.hasOwn(record, '$raw') && /^archive-line-/.test(String(record.id))
      ? record.$raw
      : record;
  }
  const operational = rows.operational[0];
  const rest = parseExtra(operational.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('intentions')) obj.intentions = records;
  return obj;
}
