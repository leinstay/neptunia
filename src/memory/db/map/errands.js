// Mapper: `errands.json` (`{ errands: [...] }`, the errands she sent out: open ones and the latest closed) and
// `errands.jsonl` (one line per transition of an errand) <-> `work` rows (kind errand) and `work_events` rows, and
// `operational` (kind errands) for the rest of errands.json. A value an earlier release wrote, `{ tasks: [...] }`,
// maps the same as `{ errands: [...] }`.
//
// The `record` column holds the errand (or event line) verbatim and is the authority; state, created_ms,
// updated_ms (the end, else the start, else the creation), outcome (the error text), seen and the scope are copies
// of its fields for queries. The scope: an errand's `scope` word with its requester (scope-string.js). An event's id
// is `<errand id>:<at>:<position>`, so two identical lines stay two events.
//
// toRows(rel, valueOrLine, ctx) -> { work, operational? } | { work_events }     ctx: { position? } (event lines)
// fromRows(rows, ctx) -> the file's value, or the event line

import { isPlainObject, ordered, parseExtra, put, rowsOf } from './common.js';
import { stringScope } from './scope-string.js';

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' ? value : null);

export const isEventsPath = (rel) => /errands\.jsonl$/.test(String(rel));

const mappable = (errand) => isPlainObject(errand) && typeof errand.id === 'string' && errand.id !== '';

function workRow(rel, errand, position) {
  return {
    id: errand.id,
    kind: 'errand',
    state: text(errand.state),
    record: JSON.stringify(errand),
    created_ms: num(errand.createdAt),
    updated_ms: num(errand.endedAt) ?? num(errand.startedAt) ?? num(errand.createdAt),
    outcome: text(errand.error),
    seen: typeof errand.seen === 'boolean' ? (errand.seen ? 1 : 0) : null,
    ...stringScope(errand.scope, [errand.requester?.userId]),
    owner_file: rel,
    position,
  };
}

export function toRows(rel, value, ctx = {}) {
  const rows = {};
  if (isEventsPath(rel)) {
    const position = ctx.position ?? 0;
    put(rows, 'work_events', {
      id: `${mappable(value) ? value.id : 'event'}:${num(value?.at) ?? ''}:${position}`,
      work_id: mappable(value) ? value.id : null,
      at_ms: num(value?.at),
      record: JSON.stringify(value),
      owner_file: rel,
      position,
    });
    return rows;
  }
  /** @type {Record<string, unknown>} */
  const rest = { ...value };
  // The list under either key; the value an earlier release wrote names it `tasks`.
  const list = Array.isArray(rest.errands) ? rest.errands : rest.tasks;
  const ids = Array.isArray(list) ? list.map((errand) => errand?.id) : [];
  if (Array.isArray(list) && list.every(mappable) && new Set(ids).size === ids.length) {
    list.forEach((errand, position) => put(rows, 'work', workRow(rel, errand, position)));
    delete rest.errands;
    delete rest.tasks;
    rest.$has = ['errands'];
  } else {
    rest.$has = [];
  }
  put(rows, 'operational', { kind: 'errands', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const events = rowsOf(rows, 'work_events');
  if (events.length) return JSON.parse(events[0].record);
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('errands')) obj.errands = ordered(rows, 'work').map((row) => JSON.parse(row.record));
  return obj;
}
