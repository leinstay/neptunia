// Mapper: a member's private layer `private/<id>.json` (what she learned in direct messages) <-> rows, every row
// scoped to that member's DM. No `people` or `accounts` row: those belong to the public file of the same member.
//
//   claims, episodes, descriptions (relationship), affinity_events    as in src/memory/db/map/user.js, scope dm
//   operational (kind private)   the rest: the affinity score, reason and decay stamp, first/last seen, detailsSeq,
//                                relationshipScore, `replies`, `buffer`, ...
//
// toRows(rel, value, ctx) -> { claims, episodes, ..., operational }
// fromRows(rows, ctx) -> the file's value

import { personId } from '../ids.js';
import { dmScope } from '../scope.js';
import { historyFrom, profileFrom, profileRows } from './lists.js';
import { isPlainObject, parseExtra, put, rowsOf } from './common.js';

const FIELDS = ['relationship'];

/** The member id in `private/<id>.json`. */
export const privateIdOf = (rel) => /([^/]+)\.json$/.exec(String(rel))?.[1] ?? String(rel);

export function toRows(rel, value) {
  const userId = privateIdOf(rel);
  const person = personId(userId);
  const rows = {};
  const { rest, affinity } = profileRows(rows, value, {
    rel, person, owner: `${person}:dm`, tag: ':dm', scope: dmScope(person), descFields: FIELDS,
  });
  if (affinity) rest.affinity = affinity;
  put(rows, 'operational', { kind: 'private', owner: person, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const row = rowsOf(rows, 'operational')[0];
  const rest = parseExtra(row?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const affinity = has.includes('affinity') && isPlainObject(rest.affinity) ? rest.affinity : null;
  const obj = { ...rest };
  if (has.includes('affinity')) delete obj.affinity;
  Object.assign(obj, profileFrom(rows, has));
  if (has.includes('affinity')) {
    obj.affinity = { ...(affinity ?? {}) };
    if (has.includes('affinity.history')) obj.affinity.history = historyFrom(rows);
  }
  return obj;
}
