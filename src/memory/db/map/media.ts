// Mapper: `media.json` (`{ <key>: { text, ts }, ... }`, the describer's cache of what she saw in an attachment or a link) <->
// `media` rows. A live write goes through media-store.ts#writeMediaCache, onto the items; this mapper reads the rows back and
// gives a file's rows to an import. A key names a reference and, by its prefix, a kind (media-store.ts#cacheKeyParts); the text is
// `description`, a video's still frame beside its watched summary `extra.frame`; each key's other fields stay in `extra.cache`.
//
// toRows(rel, value, ctx) -> { media }     fromRows(rows, ctx) -> the file's value

import { cacheKeyParts } from '../media-store.ts';
import { groupScope } from '../scope.ts';
import { ifaceOf, isPlainObject, parseExtra, put, rowsOf } from './common.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext } from './common.ts';

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const iface = ifaceOf(ctx);
  const rows: Rows = {};
  for (const [key, entry] of Object.entries(value)) {
    const given = isPlainObject(entry) ? { ...entry } : { $raw: entry };
    const text = typeof given.text === 'string' ? given.text : null;
    delete given.text;
    const { ref, kinds } = cacheKeyParts(key);
    put(rows, 'media', {
      id: `media:${iface}:${key}`,
      kind: kinds?.[0] ?? 'image',
      native_ref: ref,
      description: text,
      ...groupScope(iface),
      extra: JSON.stringify({ cache: { [key]: given } }),
      owner_file: rel,
    });
  }
  return rows;
}

export function fromRows(rows: Rows): Row {
  const obj: Row = {};
  for (const row of rowsOf(rows, 'media')) {
    const extra = parseExtra(row.extra);
    const entries = isPlainObject(extra.cache) ? extra.cache : {};
    for (const [key, entry] of Object.entries(entries)) {
      if (isPlainObject(entry) && Object.hasOwn(entry, '$raw')) {
        obj[key] = entry.$raw;
        continue;
      }
      const prefixed = cacheKeyParts(key).kinds !== null && key !== row.native_ref;
      const isFrame = row.kind === 'video' && !prefixed && extra.watched === true;
      const text = isFrame ? extra.frame : row.description;
      obj[key] = { ...(typeof text === 'string' && text !== '' ? { text } : {}), ...(entry as Row) };
    }
  }
  return obj;
}
