// Mapper: a channel's map entry `channels/<id>.json` <-> rows.
//
//   places           the channel (name, category, topic), under the guild's place
//   descriptions     purpose, topics, tone (subject: the channel's place), one legacy version each
//   operational      kind channel: everything else (day counts, message counts, first/last message, top writers,
//                    writers, notes stamps, ...), kept as it was
//
// toRows(rel, value, ctx) -> { places, descriptions, description_versions, operational }     ctx: { guildId? }
// fromRows(rows, ctx) -> the file's value

import { channelPlaceId, guildPlaceId } from '../ids.ts';
import { groupScope } from '../scope.ts';
import { ifaceOf, join, parseExtra, put, rowsOf, split } from './common.js';

const PLACE_SPEC = [
  { col: 'native_id', key: 'id', type: 'text' },
  { col: 'name', key: 'name', type: 'text' },
  { col: 'category', key: 'category', type: 'text' },
  { col: 'topic', key: 'topic', type: 'text' },
];
const FIELDS = ['purpose', 'topics', 'tone'];

export const channelIdOf = (rel) => /([^/]+)\.json$/.exec(String(rel))?.[1] ?? String(rel);

export function toRows(rel, value, ctx = {}) {
  const iface = ifaceOf(ctx);
  const placeId = channelPlaceId(iface, channelIdOf(rel));
  const rows = {};
  const { cols, rest } = split(value, PLACE_SPEC);
  const scope = groupScope(iface);
  put(rows, 'places', {
    id: placeId,
    iface,
    kind: 'channel',
    ...cols,
    parent_id: ctx.guildId ? guildPlaceId(iface, ctx.guildId) : null,
    scope_kind: 'group',
    extra: null,
    retired_at: null,
    owner_file: rel,
  });
  for (const field of FIELDS) {
    if (typeof value[field] !== 'string') continue;
    const id = `desc:${placeId}:${field}`;
    put(rows, 'descriptions', {
      id,
      subject_kind: 'place',
      subject_id: placeId,
      field,
      ...scope,
      current_version: `${id}:legacy`,
      owner_file: rel,
    });
    put(rows, 'description_versions', {
      id: `${id}:legacy`,
      description_id: id,
      text: value[field],
      author: 'import',
      written_at: null,
      chars: [...value[field]].length,
      kept: null,
      removed: null,
      added: null,
      reason: null,
      origin: 'legacy',
      extra: null,
      owner_file: rel,
      position: 0,
    });
    delete rest[field];
  }
  put(rows, 'operational', { kind: 'channel', owner: placeId, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const place = rows.places[0];
  const operational = rowsOf(rows, 'operational')[0];
  const obj = join(place, parseExtra(operational?.value), PLACE_SPEC);
  const versions = new Map(rowsOf(rows, 'description_versions').map((row) => [row.description_id, row]));
  for (const description of rowsOf(rows, 'descriptions')) {
    const version = versions.get(description.id);
    if (version) obj[description.field] = version.text;
  }
  return obj;
}
