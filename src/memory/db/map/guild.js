// Mapper: `guild.json` <-> rows.
//
//   places        the guild
//   descriptions  patterns, starters (subject: the guild's place), one legacy version each
//   claims        injokes (kind injoke, subject the guild), self (kind self_fact, subject her, scope none),
//                 learned (kind lesson, how taught, `from_person` the teacher)
//   operational   kind guild: everything else (`learnedNextId`, emoji usage, notes stamps, the pings-off list, ...)
//
// toRows(rel, value, ctx) -> { places, descriptions, description_versions, claims, operational }     ctx: { guildId }
// fromRows(rows, ctx) -> the file's value

import { IFACE, SELF_PERSON, guildPlaceId, nativeOf, personId } from '../ids.js';
import { SCOPE_NONE, groupScope } from '../scope.js';
import { claimItems, claimRows } from './lists.js';
import { parseExtra, put, rowsOf } from './common.js';

const FIELDS = ['patterns', 'starters'];

const LEARNED_SPEC = [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
  {
    col: 'from_person',
    key: 'from',
    type: 'text',
    ok: (v) => /^<@\d+>$/.test(v),
    enc: (v) => personId(v.slice(2, -1)),
    dec: (id) => `<@${nativeOf(id)}>`,
  },
];

const LISTS = [
  { key: 'injokes', kind: 'injoke', strings: true, subject: 'place', scope: 'group' },
  { key: 'self', kind: 'self_fact', strings: true, subject: 'self', scope: 'none' },
  {
    key: 'learned',
    kind: 'lesson',
    spec: LEARNED_SPEC,
    stable: (item) => [item.id ?? item.text],
    subject: 'place',
    scope: 'group',
    how: 'taught',
  },
];

export function toRows(rel, value, ctx = {}) {
  const guildId = ctx.guildId ?? 'unknown';
  const placeId = guildPlaceId(guildId);
  const rows = {};
  const rest = { ...value };
  put(rows, 'places', {
    id: placeId,
    iface: IFACE,
    kind: 'guild',
    native_id: guildId,
    parent_id: null,
    scope_kind: 'group',
    name: null,
    category: null,
    topic: null,
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
      ...groupScope(),
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
  const has = [];
  for (const def of LISTS) {
    if (!Object.hasOwn(value, def.key)) continue;
    const self = def.subject === 'self';
    const ok = claimRows(rows, value[def.key], def, {
      rel,
      subject_kind: self ? 'self' : 'place',
      subject_id: self ? SELF_PERSON : placeId,
      owner: self ? SELF_PERSON : placeId,
      scope: self ? { ...SCOPE_NONE } : groupScope(),
      how: def.how,
    });
    if (ok) {
      delete rest[def.key];
      has.push(def.key);
    }
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'guild', owner: placeId, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  const versions = new Map(rowsOf(rows, 'description_versions').map((row) => [row.description_id, row]));
  for (const description of rowsOf(rows, 'descriptions')) {
    const version = versions.get(description.id);
    if (version) obj[description.field] = version.text;
  }
  for (const def of LISTS) {
    if (!has.includes(def.key)) continue;
    obj[def.key] = claimItems(
      rowsOf(rows, 'claims').filter((row) => row.kind === def.kind),
      def
    );
  }
  return obj;
}
