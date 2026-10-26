// Mapper: `gifs.json` (`{ nextId, entries: { <key>: { id, kind, url, site, messageId, channelId, itemId, name,
// firstSeen, last, count, ownUses, ownLast } } }`, the gifs she has seen and used) <-> `media` rows of kind gif and
// `operational` (kind gifs) for the rest of the file (`nextId`).
//
// The entry's key is the row's id after `media:gif:`; `url` is `path`, `messageId` the `native_ref`, `name` the
// description. Counts, stamps, the site, the entry's own `kind` and `id` stay in `extra`. An entry that is not an
// object is kept whole as `{ $raw: value }`. The scope is group.
//
// toRows(rel, value, ctx) -> { media, operational }     fromRows(rows, ctx) -> the file's value

import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.js';

const PREFIX = 'media:gif:';

const SPEC = [
  { col: 'path', key: 'url', type: 'text' },
  { col: 'native_ref', key: 'messageId', type: 'text' },
  { col: 'description', key: 'name', type: 'text' },
];

export function toRows(rel, value, ctx = {}) {
  const iface = ifaceOf(ctx);
  const rows = {};
  const rest = { ...value };
  const has = [];
  if (isPlainObject(value.entries)) {
    for (const [key, entry] of Object.entries(value.entries)) {
      const part = isPlainObject(entry)
        ? split(entry, SPEC)
        : { cols: { path: null, native_ref: null, description: null }, rest: { $raw: entry } };
      put(rows, 'media', {
        id: `${PREFIX}${key}`,
        kind: 'gif',
        owner: null,
        ...part.cols,
        described_at: null,
        sha1: null,
        bytes: null,
        mime: null,
        ...groupScope(iface),
        extra: extraText(part.rest),
        owner_file: rel,
      });
    }
    delete rest.entries;
    has.push('entries');
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'gifs', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('entries')) {
    obj.entries = {};
    for (const row of rowsOf(rows, 'media')) {
      const extra = parseExtra(row.extra);
      obj.entries[row.id.slice(PREFIX.length)] = Object.hasOwn(extra, '$raw') ? extra.$raw : join(row, extra, SPEC);
    }
  }
  return obj;
}
