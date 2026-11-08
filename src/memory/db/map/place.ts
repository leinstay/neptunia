// Mapper: the notes of a place <-> rows.
//
//   places        the place, only when no row holds it yet: what the interface reported stays as stored
//   descriptions  purpose, tone, topics, patterns, starters (subject: the place), one legacy version each; a root and a
//                 direct chat carry the three fields of every place with lines, beside a root's patterns and starters
//   claims        injokes (kind injoke, subject the place), self (kind self_fact, subject her),
//                 learned (kind lesson, how taught, `from_person` the teacher)
//   A DM place's descriptions, in-jokes, self facts and lessons are scoped to that DM; every other place's to the groups.
//   operational   kind place: everything else (`learnedNextId`, emoji usage, notes stamps, the pings-off list, ...)
//
// toRows(rel, value, ctx) -> { places, descriptions, description_versions, claims, operational }     ctx: { subjectId }
// fromRows(rows, ctx) -> the file's value

import { SELF_PERSON, personId } from '../ids.ts';
import { groupScope } from '../scope.ts';
import { dmPlaceScope } from './scope-parts.ts';
import { claimItems, claimRows } from './lists.ts';
import type { ListDef } from './lists.ts';
import { ifaceOf, parseExtra, put, rowsOf } from './common.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

const FIELDS = ['purpose', 'tone', 'topics', 'patterns', 'starters'];

/**
 * A lesson's columns. Its teacher, a mention `<@platform id>`, is the stored person of the teacher's account on the
 * place's interface, null when no stored account holds it. The mention stays beside the person, since no person gives
 * it back.
 */
const learnedSpec = (ctx: MapContext): Array<Spec> => [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
  {
    col: 'from_person',
    key: 'from',
    type: 'text',
    ok: (v: unknown) => /^<@\d+>$/.test(String(v)),
    // The import of the legacy files has no database, so only it spells the person from the platform id.
    enc: (v: unknown) => {
      const platformId = String(v).slice(2, -1);
      return ctx.personOfMember ? ctx.personOfMember(ifaceOf(ctx), platformId) : personId(ifaceOf(ctx), platformId);
    },
    dec: () => null,
    exact: true,
  },
];

const listsOf = (ctx: MapContext): Array<ListDef & { subject: string }> => [
  { key: 'injokes', kind: 'injoke', strings: true, subject: 'place' },
  { key: 'self', kind: 'self_fact', strings: true, subject: 'self' },
  {
    key: 'learned',
    kind: 'lesson',
    spec: learnedSpec(ctx),
    stable: (item: Row) => [item.id ?? item.text],
    subject: 'place',
    how: 'taught',
  },
];

/** What the notes of a place are shown to: its partner in a DM, the groups elsewhere. */
function notesScope(iface: string, ctx: MapContext): Row {
  if (!ctx.dmPlace || !ctx.privateAccountId) return groupScope(iface);
  return dmPlaceScope(iface, ctx.dmPlace);
}

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const iface = ifaceOf(ctx);
  const placeId = ctx.subjectId ?? rel;
  const rows: Rows = {};
  const rest = { ...value };
  const scope = notesScope(iface, ctx);
  if (ctx.subjectPlace) {
    // The row the database holds stays as stored (channel.ts does the same): the unit owns it, so a write that left it
    // out would retire it.
    put(rows, 'places', { ...ctx.subjectPlace, owner_file: rel });
  } else {
    put(rows, 'places', {
      id: placeId,
      iface,
      kind: ctx.dmPlace ? 'dm' : 'server',
      native_id: ctx.subjectNativeId ?? placeId,
      parent_id: null,
      scope_kind: ctx.dmPlace ? 'dm' : 'group',
      name: null,
      topic: null,
      extra: null,
      retired_at: null,
      owner_file: rel,
    });
  }
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
  const has = [];
  for (const def of listsOf(ctx)) {
    if (!Object.hasOwn(value, def.key)) continue;
    const self = def.subject === 'self';
    const ok = claimRows(rows, value[def.key], def, {
      rel,
      subject_kind: self ? 'self' : 'place',
      subject_id: self ? SELF_PERSON : placeId,
      owner: self ? SELF_PERSON : placeId,
      scope,
      how: def.how,
    });
    if (ok) {
      delete rest[def.key];
      has.push(def.key);
    }
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'place', owner: placeId, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows: Rows): Row {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  const versions = new Map(rowsOf(rows, 'description_versions').map((row) => [row.description_id, row]));
  for (const description of rowsOf(rows, 'descriptions')) {
    const version = versions.get(description.id);
    if (version) obj[String(description.field)] = version.text;
  }
  for (const def of listsOf({})) {
    if (!has.includes(def.key)) continue;
    obj[def.key] = claimItems(
      rowsOf(rows, 'claims').filter((row) => row.kind === def.kind),
      def
    );
  }
  return obj;
}
