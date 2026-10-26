// Mapper: `recent.json` (`{ nextId, lines: [...] }`, the lines she said lately and does not want to repeat) <->
// `claims` rows of kind recent_line (subject the channel's place, the line's own `itemId` the claim id; a derived id,
// marked `$derived`, when it has none) and `operational` (kind recent) for the rest of the file. The line's numeric
// `id`, `at` (ms) and `who` stay in `extra`; `addedAt` is created_at.
//
// toRows(rel, value, ctx) -> { claims, operational }     fromRows(rows, ctx) -> the file's value

import { channelPlaceId, itemOrDerivedId, nativeOf, uniqueIds } from '../ids.js';
import { groupScope } from '../scope.js';
import { extraText, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';

const SPEC = [
  {
    col: 'subject_id',
    key: 'channelId',
    type: 'text',
    ok: (v) => nativeOf(channelPlaceId(v)) === v,
    enc: channelPlaceId,
    dec: nativeOf,
  },
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'created_at', key: 'addedAt', type: 'text' },
];

export function toRows(rel, value) {
  const rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.lines) && value.lines.every(isPlainObject)) {
    const uniq = uniqueIds();
    value.lines.forEach((line, position) => {
      const part = split(line, SPEC);
      const itemId = typeof line.itemId === 'string' && line.itemId ? line.itemId : null;
      const base =
        itemId ?? itemOrDerivedId(null, 'recent_line', line.channelId ?? '', line.at ?? '', line.id ?? position);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'claims', {
        id,
        ...part.cols,
        subject_kind: 'place',
        kind: 'recent_line',
        extra: extraText(part.rest),
        first_seen_at: null,
        last_seen_at: null,
        valid_to: null,
        superseded_by: null,
        how: 'legacy',
        author: 'import',
        from_person: null,
        truth: 'current',
        shown: 1,
        ...groupScope(),
        retired_at: null,
        origin_file: rel,
        owner_file: rel,
        position,
      });
    });
    delete rest.lines;
    has.push('lines');
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'recent', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('lines')) {
    obj.lines = ordered(rows, 'claims').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const line = join(row, extra, SPEC);
      if (!derived) line.itemId = row.id;
      return line;
    });
  }
  return obj;
}
