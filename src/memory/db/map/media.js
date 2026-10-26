// Mapper: `media.json` (`{ <key>: { text, ts }, ... }`, what she saw in an attachment or a link, by the attachment's
// or link's key) <-> `media` rows of kind attachment. The key is the row's `native_ref` (the id is
// `media:attachment:<key>`), `text` the description; `ts` (ms) and anything else stay in `extra`. A key whose value
// is not an object is kept whole as `{ $raw: value }`. The scope is group.
//
// toRows(rel, value, ctx) -> { media }     fromRows(rows, ctx) -> the file's value

import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.js';

const SPEC = [{ col: 'description', key: 'text', type: 'text' }];

export function toRows(rel, value, ctx = {}) {
  const iface = ifaceOf(ctx);
  const rows = {};
  for (const [key, entry] of Object.entries(value)) {
    const part = isPlainObject(entry) ? split(entry, SPEC) : { cols: { description: null }, rest: { $raw: entry } };
    put(rows, 'media', {
      id: `media:attachment:${key}`,
      kind: 'attachment',
      owner: null,
      path: null,
      native_ref: key,
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
  return rows;
}

export function fromRows(rows) {
  const obj = {};
  for (const row of rowsOf(rows, 'media')) {
    const rest = parseExtra(row.extra);
    obj[row.native_ref] = Object.hasOwn(rest, '$raw') ? rest.$raw : join(row, rest, SPEC);
  }
  return obj;
}
