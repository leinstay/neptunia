// The notes of a place: what the store keeps about a root or a direct chat (src/memory/store.ts, `getPlace`,
// `updatePlace`, `applyLearnedOps`), owned by the unit `placeCollection('place', <place id>)`. The store writes them
// through the write kind `place-notes` (session-write.ts) and reads them back through `placeNotesValue` below.
//
//   places        the place, only when no row holds it yet: what the interface reported stays as stored
//   descriptions  purpose, tone, topics, patterns, starters (subject: the place), one legacy version each
//   claims        injokes (kind injoke, subject the place), self (kind self_fact, subject her),
//                 learned (kind lesson, how taught, `from_person` the teacher)
//   operational   kind place: everything else (`learnedNextId`, emoji usage, notes stamps, the pings, ...)
//
// A direct chat's descriptions, in-jokes, self facts and lessons are scoped to that chat; every other place's to the
// groups. A write replaces the notes: the rows the value no longer holds are retired or handed to another place that
// shares them (place-owner.ts#retirePlaceAbsent), and a description her session reviewed keeps her version while the
// notes bring the text they had (session-rows.ts#sessionHold).

import { SELF_PERSON } from './ids.ts';
import { groupScope } from './scope.ts';
import { claimItems, claimRows } from './map/lists.ts';
import type { ListDef } from './map/lists.ts';
import { ifaceOf, isPlainObject, parseExtra, put, rowsOf } from './map/common.ts';
import type { MapContext, Spec } from './map/common.ts';
import { storageContext } from './storage-context.ts';
import { dmPlaceScope } from './map/scope-parts.ts';
import {
  heldPlaceRows,
  holdsPlace,
  placeOwnerOf,
  preparedPlace,
  retirePlaceAbsent,
  stampPlaceRows,
} from './place-owner.ts';
import type { PlaceOwner } from './place-owner.ts';
import { placeCollection, keyText } from './storage-keys.ts';
import { namedIface } from './legacy-namespace.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit, noteUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole notes of one place. */
export type PlaceNotesWrite = { placeId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type PlaceNotesResult = { upserted: number; retired: number };

/** The tables the notes' rows live in. */
const TABLES = ['places', 'descriptions', 'description_versions', 'claims', 'operational'];

const FIELDS = ['purpose', 'tone', 'topics', 'patterns', 'starters'];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * A lesson's columns. Its teacher, a mention `<@platform id>`, is the stored person of the teacher's account on the
 * place's interface, the person its id spells when no stored account holds it. The mention stays beside the person,
 * since no person gives it back.
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
    enc: (v: unknown) => ctx.personOfMember?.(ifaceOf(ctx), String(v).slice(2, -1)) ?? null,
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

/** What the notes of a place are shown to: its partner in a direct chat, the groups elsewhere. */
function notesScope(iface: string, ctx: MapContext): Row {
  if (!ctx.dmPlace) return groupScope(iface);
  return dmPlaceScope(iface, ctx.dmPlace);
}

/**
 * The place row of the notes: the stored row as it is, or a new one when no row holds the place yet. A new row knows no
 * native id: the observation of the place's interface gives it one.
 */
function placeRow(ctx: MapContext, placeId: string, iface: string, owner: string): Row {
  if (ctx.subjectPlace) {
    // The unit owns the row it adopted, so a write that left it out would retire it.
    const stored: Row = { ...ctx.subjectPlace, owner_key: owner };
    delete stored.owner_file;
    return stored;
  }
  return {
    id: placeId,
    iface,
    kind: ctx.dmPlace ? 'dm' : 'server',
    native_id: null,
    parent_id: null,
    scope_kind: ctx.dmPlace ? 'dm' : 'group',
    name: null,
    topic: null,
    extra: null,
    retired_at: null,
    owner_key: owner,
  };
}

/** The rows of the notes `value` of the unit `key`, owned by `owner` (the unit's id) and `holder`. */
function placeNotesRows(
  db: Db,
  key: StorageKey,
  value: Row,
  owner: string,
  holder: PlaceOwner,
  writeIface?: string
): Rows {
  const ctx = storageContext(db, key, writeIface);
  const iface = ifaceOf(ctx);
  const placeId = ctx.subjectId ?? owner;
  const rows: Rows = {};
  const rest = { ...value };
  const scope = notesScope(iface, ctx);
  put(rows, 'places', placeRow(ctx, placeId, iface, owner));
  for (const field of FIELDS) {
    const text = value[field];
    if (typeof text !== 'string') continue;
    const id = `desc:${placeId}:${field}`;
    put(rows, 'descriptions', {
      id,
      subject_kind: 'place',
      subject_id: placeId,
      field,
      ...scope,
      current_version: `${id}:legacy`,
      owner_key: owner,
    });
    put(rows, 'description_versions', {
      id: `${id}:legacy`,
      description_id: id,
      text,
      author: 'import',
      written_at: null,
      chars: [...text].length,
      kept: null,
      removed: null,
      added: null,
      reason: null,
      origin: 'legacy',
      extra: null,
      owner_key: owner,
      position: 0,
    });
    delete rest[field];
  }
  const has = [];
  for (const def of listsOf(ctx)) {
    if (!Object.hasOwn(value, def.key)) continue;
    const self = def.subject === 'self';
    const ok = claimRows(rows, value[def.key], def, {
      rel: owner,
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
  // The notes' operational row keeps the owner it was first stored under.
  const stored = preparedPlace(
    db,
    "SELECT owner FROM operational WHERE kind = 'place' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
  ).get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'place',
    owner: stored ? stored.owner : placeId,
    value: JSON.stringify(rest),
    owner_key: owner,
  });
  // The claim lists name their unit as `owner_file` (map/lists.ts): the unit's id is their owner.
  for (const row of rows.claims ?? []) {
    delete row.owner_file;
    row.owner_key = owner;
  }
  return stampPlaceRows(rows, holder);
}

/** The notes their rows give back. */
function placeNotesOf(rows: Rows): Row {
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

/**
 * Stores the whole notes the unit `key` holds (a place's `place` unit) inside the caller's transaction and retires what
 * they no longer hold.
 */
export function writePlaceNotes(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, iface }: { at: string; iface?: string }
): PlaceNotesResult {
  const id = ensureUnit(db, key);
  const holder = placeOwnerOf(key)!; // a `place` unit always has its owner columns (place-owner.ts)
  const mapping = placeNotesRows(db, key, value, id, holder, iface);
  const upserted = writeMapping(db, mapping, id, { at, holder });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'place', { at });
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function placeNotesWriteOf(update: Row): PlaceNotesWrite {
  if (!filled(update.placeId)) throw coded('PLACE_NOTES_PLACE');
  if (!isPlainObject(update.value)) throw coded('PLACE_NOTES_VALUE');
  return { placeId: update.placeId, value: update.value };
}

/** Whether `key` names a place's notes. */
export const isPlaceNotesKey = (key: StorageKey | undefined): boolean => key?.kind === 'place';

/** The write of a unit update of a place's notes (a value write of the place's own `place` unit), else null. */
export function placeNotesOfUnit(update: Row): PlaceNotesWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || !key || !isPlaceNotesKey(key) || key.subject?.type !== 'place') return null;
  if (keyText(placeCollection('place', key.subject.id)) !== keyText(key)) return null;
  return placeNotesWriteOf({ placeId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `place-notes` on the writer connection (session-write.ts). */
export function applyPlaceNotesWrite(handle: MemoryHandle, update: Row): PlaceNotesResult {
  const write = placeNotesWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeCollection('place', write.placeId);
  return handle.transaction(() =>
    writePlaceNotes(dbOf(handle), key, write.value, { at, iface: namedIface(update) ?? undefined })
  );
}

/** The notes the unit `key` holds (a place's `place` unit), or not found when the database holds none. */
export function placeNotesValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: placeNotesOf(heldPlaceRows(db, holder, TABLES)) };
}
