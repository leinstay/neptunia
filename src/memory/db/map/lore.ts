// Mapper: a place's lorebook `lore.json` (an array of entries) <-> `claims` rows of kind lore, subject the
// place. The entry's text is the claim's text, its weight the weight, createdAt / updatedAt the first / last seen
// stamps, and `source` the author ('owner' stays owner). The title, keys and the always flag are in `extra`; the
// entry's own id is the claim id after `lore:`.
//
// toRows(rel, entries, ctx) -> { claims }      ctx: { subjectId }
// fromRows(rows, ctx) -> the array

import { uniqueIds } from '../ids.ts';
import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, join, ordered, parseExtra, put, split } from './common.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

const SPEC: Array<Spec> = [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'createdAt', type: 'text' },
  { col: 'last_seen_at', key: 'updatedAt', type: 'text' },
  { col: 'author', key: 'source', type: 'text' },
];

const PREFIX = 'lore:';

export function toRows(
  rel: string,
  value: ReadonlyArray<Row> | { entries?: ReadonlyArray<Row> },
  ctx: MapContext = {}
): Rows {
  const entries = Array.isArray(value)
    ? (value as ReadonlyArray<Row>)
    : ((value as { entries?: ReadonlyArray<Row> }).entries ?? []);
  const iface = ifaceOf(ctx);
  const rows: Rows = {};
  const uniq = uniqueIds();
  const placeId = ctx.subjectId ?? rel;
  entries.forEach((entry: Row, position: number) => {
    const part = split(entry, SPEC);
    const wanted = typeof entry.id === 'string' && entry.id !== '' ? `${PREFIX}${entry.id}` : null;
    const id = uniq(wanted ?? `${PREFIX}#${position}`);
    if (wanted && id === wanted) delete part.rest.id;
    else part.rest.$noId = true;
    put(rows, 'claims', {
      id,
      subject_kind: 'place',
      subject_id: placeId,
      kind: 'lore',
      from_person: null,
      how: 'legacy',
      truth: 'current',
      shown: 1,
      ...part.cols,
      extra: extraText(part.rest),
      ...groupScope(iface),
      created_at: null,
      retired_at: null,
      origin_file: rel,
      owner_file: rel,
      position,
    });
  });
  return rows;
}

export function fromRows(rows: Rows): Array<Row> {
  return ordered(rows, 'claims').map((row) => {
    const rest = parseExtra(row.extra);
    const noId = rest.$noId === true;
    delete rest.$noId;
    const obj = join(row, rest, SPEC);
    if (!noId) obj.id = String(row.id).slice(PREFIX.length);
    return obj;
  });
}
