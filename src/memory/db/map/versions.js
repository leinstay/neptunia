// Mapper: a version file `versions/<kind>/<id>.json` (`{ <field>: [ { at, by, chars, before, after, kept, removed,
// added, text, itemId? }, ... ] }`, the previous texts of a prose field) <-> `description_versions` rows and one
// `operational` row (kind versions) that lists the fields and anything else the file holds.
//
// The description a field belongs to is named like the profile mappers name it: a member's file (`users/<id>`)
// `desc:person:discord:<id>:<field>`, a channel's `desc:discord:channel:<id>:<field>`, the guild's
// `desc:discord:guild:<guildId>:<field>` (ctx.guildId), a lorebook entry's `desc:lore:<file key>:<field>`.
// A version's id is `<description id>:v<position>`; `at` is written_at, `by` the author, origin legacy; `before`,
// `after`, `itemId` and unnamed keys are in `extra`. The operational row keeps `{ $has: { <field>: <description id> } }`
// (so a field with no versions stays an empty list) and every field that is not a list of objects.
//
// toRows(rel, value, ctx) -> { description_versions, operational }     ctx: { guildId? }
// fromRows(rows, ctx) -> the file's value

import { channelPlaceId, guildPlaceId, personId } from '../ids.js';
import { extraText, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';

const SPEC = [
  { col: 'written_at', key: 'at', type: 'text' },
  { col: 'author', key: 'by', type: 'text' },
  { col: 'chars', key: 'chars', type: 'num' },
  { col: 'kept', key: 'kept', type: 'num' },
  { col: 'removed', key: 'removed', type: 'num' },
  { col: 'added', key: 'added', type: 'num' },
  { col: 'text', key: 'text', type: 'text' },
  { col: 'reason', key: 'reason', type: 'text' },
];

/** `[kind, key]` of a version file path. */
export function versionKeyOf(rel) {
  const match = /^versions\/([^/]+)\/(.+)\.json$/.exec(String(rel));
  return match ? [match[1], match[2]] : ['unknown', String(rel)];
}

/** The prefix of the description ids of a version file: `desc:<subject id>`. */
export function descriptionPrefix(rel, ctx = {}) {
  const [kind, key] = versionKeyOf(rel);
  if (kind === 'users') return `desc:${personId(key)}`;
  if (kind === 'channels') return `desc:${channelPlaceId(key)}`;
  if (kind === 'guild') return `desc:${guildPlaceId(ctx.guildId ?? 'unknown')}`;
  return `desc:${kind}:${key}`;
}

export function toRows(rel, value, ctx = {}) {
  const rows = {};
  const rest = { ...value };
  const has = {};
  const prefix = descriptionPrefix(rel, ctx);
  for (const [field, list] of Object.entries(value)) {
    if (!Array.isArray(list) || !list.every(isPlainObject)) continue;
    const descriptionId = `${prefix}:${field}`;
    has[field] = descriptionId;
    delete rest[field];
    list.forEach((item, position) => {
      const part = split(item, SPEC);
      put(rows, 'description_versions', {
        id: `${descriptionId}:v${position}`,
        description_id: descriptionId,
        ...part.cols,
        origin: 'legacy',
        extra: extraText(part.rest),
        owner_file: rel,
        position,
      });
    });
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'versions', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = isPlainObject(rest.$has) ? rest.$has : {};
  delete rest.$has;
  const obj = {};
  const versions = ordered(rows, 'description_versions');
  for (const [field, descriptionId] of Object.entries(has)) {
    obj[field] = versions.filter((row) => row.description_id === descriptionId).map((row) => join(row, row.extra, SPEC));
  }
  return { ...rest, ...obj };
}
