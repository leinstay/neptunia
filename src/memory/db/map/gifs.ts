// Mapper: the GIF library (`{ nextId, entries: { <key>: { id, kind, url, file, site, messageId, placeId, itemId, name,
// firstSeen, last, count, ownUses, ownLast, places, caption } } }`, the gifs she has seen and used) <-> `media` rows of kind
// gif and `operational` (kind gifs) for the rest of the value (`nextId`).
//
// The entry's key is the row's id after `media:gif:`; `file` is `path`, which is null or a file under `media/` as on every
// media row, `itemId` the `native_ref`. The row is the GIF's item, so its `description` is the item's text form and this
// mapper leaves it alone; the name, the message, the link, counts, stamps, the site, the entry's own `kind` and `id` stay in
// `extra`. An entry that is not an object is kept whole as `{ $raw: value }`. The scope is group.
//
// toRows(rel, value, ctx) -> { media, operational }     fromRows(rows, ctx) -> the file's value

import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

const PREFIX = 'media:gif:';

const SPEC: Array<Spec> = [
  { col: 'path', key: 'file', type: 'text', ok: (value) => String(value).startsWith('media/') },
  { col: 'native_ref', key: 'itemId', type: 'text' },
];

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const iface = ifaceOf(ctx);
  const rows: Rows = {};
  const rest = { ...value };
  const has = [];
  if (isPlainObject(value.entries)) {
    for (const [key, entry] of Object.entries(value.entries)) {
      const part = isPlainObject(entry)
        ? split(entry, SPEC)
        : { cols: { path: null, native_ref: null }, rest: { $raw: entry } };
      put(rows, 'media', {
        id: `${PREFIX}${key}`,
        kind: 'gif',
        ...part.cols,
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

export function fromRows(rows: Rows): Row {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('entries')) {
    const entries: Row = {};
    obj.entries = entries;
    for (const row of rowsOf(rows, 'media')) {
      const extra = parseExtra(row.extra);
      for (const field of ['textOrigin', 'frame', 'watched', 'cache']) delete extra[field];
      entries[String(row.id).slice(PREFIX.length)] = Object.hasOwn(extra, '$raw') ? extra.$raw : join(row, extra, SPEC);
    }
  }
  return obj;
}
