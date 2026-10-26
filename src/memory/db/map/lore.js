// Mapper: the guild's lorebook `lore.json` (an array of entries) <-> `claims` rows of kind lore, subject the guild's
// place. The entry's text is the claim's text, its weight the weight, createdAt / updatedAt the first / last seen
// stamps, and `source` the author ('owner' stays owner). The title, keys and the always flag are in `extra`; the
// entry's own id is the claim id after `lore:`.
//
// toRows(rel, entries, ctx) -> { claims }      ctx: { guildId }
// fromRows(rows, ctx) -> the array

import { guildPlaceId, uniqueIds } from '../ids.js';
import { groupScope } from '../scope.js';
import { extraText, join, ordered, parseExtra, put, split } from './common.js';

const SPEC = [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'createdAt', type: 'text' },
  { col: 'last_seen_at', key: 'updatedAt', type: 'text' },
  { col: 'author', key: 'source', type: 'text' },
];

const PREFIX = 'lore:';

export function toRows(rel, entries, ctx = {}) {
  const rows = {};
  const uniq = uniqueIds();
  const placeId = guildPlaceId(ctx.guildId ?? 'unknown');
  entries.forEach((entry, position) => {
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
      ...groupScope(),
      created_at: null,
      retired_at: null,
      origin_file: rel,
      owner_file: rel,
      position,
    });
  });
  return rows;
}

export function fromRows(rows) {
  return ordered(rows, 'claims').map((row) => {
    const rest = parseExtra(row.extra);
    const noId = rest.$noId === true;
    delete rest.$noId;
    const obj = join(row, rest, SPEC);
    if (!noId) obj.id = row.id.slice(PREFIX.length);
    return obj;
  });
}
