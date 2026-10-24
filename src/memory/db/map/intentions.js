// Mapper: `intentions.json` (`{ intentions: [...] }`) and `intentions-archive.jsonl` (one closed record per line) <->
// `intentions` rows, and `operational` (kind intentions) for the rest of intentions.json.
//
// The `record` column holds the old record verbatim and is the authority; the other columns (status, due_ms,
// created_ms, updated_ms, the scope) are copies of its fields, there so a query can filter without parsing the JSON.
// `archived` is 1 for a line of the archive file. The scope is the record's `provenance.scope`: 'dm' with one
// participant is that member's DM scope, 'dm' otherwise is internal, anything else is group (scope-string.js).
//
// toRows(rel, valueOrLine, ctx) -> { intentions, operational? }     ctx: { position? } (archive lines)
// fromRows(rows, ctx) -> the file's value, or the archive line

import { isPlainObject, ordered, parseExtra, put, rowsOf } from './common.js';
import { stringScope } from './scope-string.js';

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' ? value : null);

export const isArchivePath = (rel) => /intentions-archive\.jsonl$/.test(String(rel));

function rowOf(rel, record, position, archived) {
  return {
    id: record.id,
    record: JSON.stringify(record),
    status: text(record.status),
    due_ms: num(record.dueAt),
    created_ms: num(record.createdAt),
    updated_ms: num(record.updatedAt),
    ...stringScope(record.provenance?.scope, record.provenance?.participants),
    archived: archived ? 1 : 0,
    owner_file: rel,
    position: position ?? null,
  };
}

const mappable = (record) => isPlainObject(record) && typeof record.id === 'string' && record.id !== '';

export function toRows(rel, value, ctx = {}) {
  const rows = {};
  if (isArchivePath(rel)) {
    // A line that is not a record with an id cannot be keyed: it is kept as a record under a derived id.
    const record = mappable(value) ? value : { id: `archive-line-${ctx.position ?? 0}`, $raw: value };
    put(rows, 'intentions', rowOf(rel, record, ctx.position, true));
    return rows;
  }
  const rest = { ...value };
  const list = value.intentions;
  const ids = Array.isArray(list) ? list.map((record) => record?.id) : [];
  if (Array.isArray(list) && list.every(mappable) && new Set(ids).size === ids.length) {
    list.forEach((record, position) => put(rows, 'intentions', rowOf(rel, record, position, false)));
    delete rest.intentions;
    rest.$has = ['intentions'];
  } else {
    rest.$has = [];
  }
  put(rows, 'operational', { kind: 'intentions', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows, ctx = {}) {
  const records = ordered(rows, 'intentions').map((row) => JSON.parse(row.record));
  if (rowsOf(rows, 'operational').length === 0) {
    const record = records[0];
    return isPlainObject(record) && Object.hasOwn(record, '$raw') && /^archive-line-/.test(record.id) ? record.$raw : record;
  }
  const rest = parseExtra(rows.operational[0].value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('intentions')) obj.intentions = records;
  return obj;
}
